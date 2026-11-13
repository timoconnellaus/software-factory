// The babysitter's deliverer (spec 53, ADRs 0580 and 0585): engine code, no model, that lands
// approved merges one repository queue at a time. A work item on Workflow v11 enters the queue with
// its merge approval (`driver: babysitter`) and waits for `delivered-<item>`; from there this pass
// does what the item's own Workflow did in v4–v7 (`landV4`, ADR 0330): bring the head up to date
// with the default branch, wait for CI on the new head, merge it with the head pinned and the
// approval, and say how it ended.
//
// It is a reconcile pass, not a loop that waits: each pass reads the queue and GitHub afresh, does
// what the state allows, and records when to look again. It is woken by the outbox (`delivery.wake`:
// an entry joined or left, CI settled on a head it updated) and by the minute cron for queues whose
// `next_check_at` has passed, which heals a lost webhook. Only one pass per repository runs at a
// time: `core_delivery_state` is the engine's own bookkeeping (like the outbox's, ADR 0586), one
// row per repository, claimed by a compare-and-set. Its `rev` is the pass's fencing token: every
// operation the pass calls carries it (`lease`), so a pass that outlived its lease changes nothing,
// GitHub included. Every change to factory state goes through operations as the BABYSITTER actor.
import {
  BABYSITTER,
  type BabysitReason,
  babysitResult,
  has,
  invoke,
  isOperationError,
  NO_BABYSIT_RUNNER,
} from "@software-factory/core";
import { parseJson } from "@software-factory/db";
import { invokeDeps } from "../deps.ts";

/** How long one pass may hold its queue before another may take over (a pass that died). */
export const PASS_MS = 60_000;
/** GitHub's update-branch is asynchronous: look again this soon, and give up after this long. */
export const UPDATE_RECHECK_MS = 15_000;
export const UPDATE_GIVE_UP_MS = 2 * 60_000;
/** CI on an updated head: look again without an event this often; give up as landV4 did. */
export const CI_RECHECK_MS = 10 * 60_000;
export const CI_GIVE_UP_MS = 12 * CI_RECHECK_MS;
export const CI_MISSING_GIVE_UP_MS = 3 * CI_RECHECK_MS;
/** A verified head whose factory/verify still waits at the merge (#190 review): bounded like CI. */
export const UNVERIFIED_GIVE_UP_MS = CI_GIVE_UP_MS;
/** A held queue: `main.observe` wakes it when main is green; this is only the safety look. */
const HELD_RECHECK_MS = 30 * 60_000;
/** A queue whose head is someone else's (a v4–v7 Workflow) or empty: a slow safety look. */
const IDLE_RECHECK_MS = 60 * 60_000;
/**
 * A `babysit` job at work on the head (spec 53 §4): its hand-back wakes the queue, so this is only
 * the safety look.
 */
export const BABYSIT_RECHECK_MS = 10 * 60_000;
/** A babysit job no runner has claimed in this long ends the wait (no runner online at all). */
export const BABYSIT_UNCLAIMED_MS = 30 * 60_000;
/** Rounds of one wake: a pass, then again while something changed meanwhile. */
const ROUNDS = 5;
/**
 * Update-branch requests per entry: a default branch that keeps moving while CI runs gets the head
 * updated (and CI'd) at most this many times, then the head is held and a person asked whether to
 * update once more (`mergeQueue.hold`); good, approved work is never sent back for it (spec 53).
 */
export const MAX_UPDATES = 3;

/**
 * Test seams only (deterministic races): `beforeMark` after CI was read green and before the head is
 * marked merging; `beforeLand` after the mark and before pr.merge.
 */
export const deliverTestSeams: {
  beforeMark: ((workItemId: string) => Promise<void>) | null;
  beforeLand: ((workItemId: string) => Promise<void>) | null;
} = { beforeMark: null, beforeLand: null };

/** The pass's lease on its repository: sent with every operation it calls. */
interface Lease {
  key: string;
  rev: number;
}

/** Another pass took the repository over: this one stops, changing nothing more. */
class LeaseLost extends Error {}
/**
 * An item's pinned workflow can't be read (fourth review of #185): that item, and only that item,
 * leaves; the rest go on.
 */
class Unreadable extends Error {
  constructor(
    message: string,
    readonly workItemId: string | null,
  ) {
    super(message);
  }
}

interface HeadRow {
  id: string;
  work_item_id: string;
  pending_action_id: string | null;
  approved_sha: string;
  head_sha: string;
  driver: "workflow" | "babysitter";
  update_asked_at: string | null;
  merging_at: string | null;
  held_until: string | null;
  updated_at: string;
  item_status: string;
  number: number;
  repairs_main: number;
  project_id: string;
  repository_id: string;
  kind: string;
  workflow_version: number | null;
}

type Called =
  | { status: "ok"; output: Record<string, unknown> }
  | { status: "pending"; pendingActionId: string }
  | { status: "refused"; code: string; message: string; details?: Record<string, unknown> };

/**
 * One key per repository, never a project-wide alias over the same queue head (an item with no
 * repository is never the babysitter's: mergeQueue.enter refuses it).
 */
export const deliveryKey = (projectId: string, repositoryId: string) =>
  `${projectId}:${repositoryId}`;

/**
 * Runs the deliverer for one repository's queue. Never throws an operation's refusal; a pass that
 * throws otherwise frees the queue and the cron looks again in a minute.
 */
export async function deliverRepository(
  env: Env,
  projectId: string,
  repositoryId: string,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const key = deliveryKey(projectId, repositoryId);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO core_delivery_state (key, project_id, repository_id, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(key, projectId, repositoryId, clock().toISOString())
    .run();
  for (let round = 1; round <= ROUNDS; round++) {
    const rev = await claim(env, key, clock());
    if (rev === null) return; // another pass runs; it was told to go round again
    let next: Date | null = new Date(clock().getTime() + 60_000);
    try {
      next = await pass(env, { key, rev }, projectId, repositoryId, clock);
    } catch (error) {
      if (error instanceof LeaseLost) return; // the pass that took over owns the row now
      throw error;
    } finally {
      const t = clock().toISOString();
      const done = await env.DB.prepare(
        `UPDATE core_delivery_state SET running_until = NULL, next_check_at = ?, updated_at = ?
         WHERE key = ? AND rev = ? RETURNING dirty`,
      )
        .bind(next?.toISOString() ?? null, t, key, rev)
        .first<{ dirty: number }>();
      if (!done || done.dirty === 0) round = ROUNDS; // nothing changed meanwhile (or taken over)
    }
  }
}

/** Claims the queue for one pass; null when another pass holds it (which then goes round again). */
async function claim(env: Env, key: string, now: Date): Promise<number | null> {
  const t = now.toISOString();
  const until = new Date(now.getTime() + PASS_MS).toISOString();
  const take = () =>
    env.DB.prepare(
      `UPDATE core_delivery_state SET rev = rev + 1, running_until = ?, dirty = 0, updated_at = ?
       WHERE key = ? AND (running_until IS NULL OR running_until < ?) RETURNING rev`,
    )
      .bind(until, t, key, t)
      .first<{ rev: number }>();
  const first = await take();
  if (first) return first.rev;
  await env.DB.prepare("UPDATE core_delivery_state SET dirty = 1 WHERE key = ?").bind(key).run();
  // The holder may have finished between the two statements, before it could see `dirty`.
  const second = await take();
  return second ? second.rev : null;
}

/** The cron's sweep: every queue that is due, or that has a babysitter entry and no state yet. */
export async function deliverDue(env: Env, now = new Date(), limit = 20): Promise<number> {
  const t = now.toISOString();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT q.project_id AS project_id, w.repository_id AS repository_id
     FROM core_merge_queue q JOIN core_work_items w ON w.id = q.work_item_id
     LEFT JOIN core_delivery_state s ON s.key = q.project_id || ':' || w.repository_id
     WHERE q.status = 'queued' AND q.driver = 'babysitter' AND w.repository_id IS NOT NULL
       AND (s.key IS NULL OR s.next_check_at IS NULL OR s.next_check_at <= ?)
     LIMIT ?`,
  )
    .bind(t, limit)
    .all<{ project_id: string; repository_id: string }>();
  for (const r of results) {
    try {
      await deliverRepository(env, r.project_id, r.repository_id, () => new Date());
    } catch (error) {
      console.error(`deliver ${deliveryKey(r.project_id, r.repository_id)} failed`, error);
    }
  }
  return results.length;
}

/** One pass: deliver heads until one has to wait. Returns when to look again (null: no need). */
async function pass(
  env: Env,
  lease: Lease,
  projectId: string,
  repositoryId: string,
  clock: () => Date,
): Promise<Date | null> {
  for (let i = 0; i < 20; i++) {
    await renew(env, lease, clock());
    const head = await readHead(env, projectId, repositoryId);
    // An empty queue, or a head an older Workflow lands itself: its leave wakes us.
    if (!head || head.driver !== "babysitter") return head ? later(clock, IDLE_RECHECK_MS) : null;
    // A paused item (a kill switch) holds the head, as it did when it landed itself.
    if (head.item_status === "paused") return later(clock, IDLE_RECHECK_MS);
    let waitMs: number | null;
    try {
      waitMs = await deliverHead(env, lease, head, clock);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      // Never blame the head for another item's refusal (fifth review of #185): the pass stops and
      // the next one looks again.
      if (error.workItemId !== head.work_item_id) throw new Error(error.message);
      // It leaves the queue, sent back as withdrawn: its Workflow (v17) parks on the owner's
      // question, an older row ends; either way the items behind it go on.
      const left = await call(
        env,
        lease,
        "mergeQueue.leave",
        {
          workItemId: head.work_item_id,
          outcome: "left",
          reason: `its workflow version can't be read: ${error.message}`,
          delivery: "withdrawn",
        },
        { idempotencyKey: `deliver:${head.id}:leave` },
      );
      if (left.status === "refused") throw new Error(`mergeQueue.leave refused: ${left.message}`);
      waitMs = null;
    }
    if (waitMs !== null) return later(clock, waitMs);
  }
  return later(clock, 60_000);
}

const later = (clock: () => Date, ms: number) => new Date(clock().getTime() + ms);

/** Extends the pass's lease before each head; a lease another pass took stops this one. */
async function renew(env: Env, lease: Lease, now: Date): Promise<void> {
  const held = await env.DB.prepare(
    "UPDATE core_delivery_state SET running_until = ? WHERE key = ? AND rev = ? RETURNING rev",
  )
    .bind(new Date(now.getTime() + PASS_MS).toISOString(), lease.key, lease.rev)
    .first<{ rev: number }>();
  if (!held) throw new LeaseLost(`lease ${lease.key}@${lease.rev} was taken over`);
}

async function readHead(
  env: Env,
  projectId: string,
  repositoryId: string,
): Promise<HeadRow | null> {
  // The same order as mergeQueue's queuedEntries for this repository: oldest open entry whose work
  // item is still open.
  return env.DB.prepare(
    `SELECT q.id, q.work_item_id, q.pending_action_id, q.approved_sha, q.head_sha, q.driver,
            q.update_asked_at, q.merging_at, q.held_until, q.updated_at,
            w.status AS item_status, w.number, w.repairs_main, q.project_id, w.repository_id,
            w.kind, w.workflow_version
     FROM core_merge_queue q JOIN core_work_items w ON w.id = q.work_item_id
     WHERE q.project_id = ?1 AND q.status = 'queued'
       AND w.status IN ('running', 'waiting', 'paused')
       AND w.repository_id = ?2
     ORDER BY (w.repairs_main = 1 AND EXISTS (SELECT 1 FROM core_main_health h
                 WHERE h.repository_id = w.repository_id AND h.red_since IS NOT NULL)) DESC,
              q.enqueued_at ASC, q.id ASC LIMIT 1`,
  )
    .bind(projectId, repositoryId)
    .first<HeadRow>();
}

async function call(
  env: Env,
  lease: Lease,
  op: string,
  input: unknown,
  opts: { approvalId?: string; idempotencyKey?: string } = {},
): Promise<Called> {
  try {
    const r = await invoke(invokeDeps(env), op, input, {
      actor: BABYSITTER,
      origin: { surface: "cron", step: `deliver: ${op}` },
      lease,
      ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
      // The rev is part of the key: a refusal recorded for a stale pass never replays to the next.
      ...(opts.idempotencyKey ? { idempotencyKey: `${opts.idempotencyKey}@${lease.rev}` } : {}),
    });
    return r.status === "ok"
      ? { status: "ok", output: (r.output ?? {}) as Record<string, unknown> }
      : { status: "pending", pendingActionId: r.pendingActionId };
  } catch (error) {
    if (!isOperationError(error)) throw error;
    if (error.code === "fenced") throw new LeaseLost(error.message);
    if (error.code === "workflow_unreadable" && op !== "mergeQueue.leave") {
      const about = (input as { workItemId?: unknown } | null)?.workItemId;
      throw new Unreadable(error.message, typeof about === "string" ? about : null);
    }
    return {
      status: "refused",
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
}

/**
 * Takes the head one step further. Returns how long to wait before looking again, or null when it
 * left the queue (merged, or handed back to its Workflow) and the next head may go.
 */
async function deliverHead(
  env: Env,
  lease: Lease,
  head: HeadRow,
  clock: () => Date,
): Promise<number | null> {
  const id = head.work_item_id;
  const end = async (
    status: "merged" | "left",
    delivery: "merged" | "conflict" | "failed" | "withdrawn" | "reverify",
    reason: string,
  ): Promise<null> => {
    const left = await call(
      env,
      lease,
      "mergeQueue.leave",
      { workItemId: id, outcome: status, reason, delivery },
      { idempotencyKey: `deliver:${head.id}:leave` },
    );
    if (left.status === "refused") throw new Error(`mergeQueue.leave refused: ${left.message}`);
    return null;
  };

  // A pass that died after the merge and before the leave: the approval was used by the merge.
  if (head.pending_action_id && (await approvalUsed(env, head.pending_action_id))) {
    return end("merged", "merged", "merged");
  }

  // Something code can't decide (spec 53 §4): the repository's `babysit` job judges it. Only for a
  // factory item whose Workflow re-verifies a withdrawn approval (v12's `reverify-on-withdrawal`):
  // a resolution is a new head a person approves again. An attached PR's conflict goes back to its
  // author (decision 8); older items, as before, back to build.
  const judge = async (
    kind: BabysitReason["kind"],
    at: string,
    checks: string[],
    fallback: string,
  ): Promise<number | null> => {
    const babysits =
      has(head.workflow_version, "reverify-on-withdrawal") &&
      !(kind === "conflict" && head.kind === "attached");
    const ending = kind === "conflict" ? "conflict" : "failed";
    const why =
      kind === "conflict"
        ? fallback
        : `Merging the default branch into your branch broke CI (${fallback}, the branch with the default branch merged in). Fix the branch against the latest default branch.`;
    if (!babysits) return end("left", ending, why);
    const woke = await call(env, lease, "babysit.wake", {
      workItemId: id,
      reason: { kind, headSha: at, checks },
    });
    if (woke.status !== "ok") return end("left", ending, `${why} (${refusal(woke)})`);
    return BABYSIT_RECHECK_MS;
  };

  const sitter = await babysitState(env, lease.key);
  if (sitter?.babysit_job_id) {
    const settled = await settleBabysit(env, lease, head, sitter);
    if (settled.kind === "wait") return settled.ms;
    if (settled.kind === "end") return end("left", settled.delivery, settled.reason);
  }
  // Stop the line (ADR 0581): while main is red only a repair lands. Held before the update too,
  // or merging a red main in would fail its CI and send good work back to build. A green
  // `main.observe` wakes the queue. A head already marked merging finishes first (GitHub may have
  // merged it).
  if (head.merging_at === null && (await held(env, lease, head))) return HELD_RECHECK_MS;
  // A person asked to wait before the next update.
  if (head.held_until && Date.parse(head.held_until) > clock().getTime()) {
    return Date.parse(head.held_until) - clock().getTime();
  }

  // Bring the head up to date (bounded: MAX_UPDATES requests per entry). Returns the head to
  // land, or how long to wait (or null: it left).
  const snapshot = async (): Promise<{ at: string; state: string } | { wait: number | null }> => {
    const u = await call(env, lease, "mergeQueue.update", {
      workItemId: id,
      maxUpdates: MAX_UPDATES,
    });
    if (u.status !== "ok") {
      return {
        wait: await end(
          "left",
          "failed",
          `the merge queue couldn't update the branch: ${refusal(u)}`,
        ),
      };
    }
    const state = String(u.output.state);
    if (state === "updating") {
      const asked = head.update_asked_at ? Date.parse(head.update_asked_at) : clock().getTime();
      if (clock().getTime() - asked < UPDATE_GIVE_UP_MS) return { wait: UPDATE_RECHECK_MS };
      return {
        wait: await end("left", "failed", "GitHub didn't finish merging the default branch in"),
      };
    }
    if (state === "conflict") {
      const reason = String(u.output.reason ?? "conflict");
      return {
        wait: await judge("conflict", String(u.output.headSha ?? head.head_sha), [], reason),
      };
    }
    // A merge of main the factory can't prove left the approved change alone: the approval no
    // longer holds, and the item goes back to its merge gate on the new head (ADR 0582).
    if (state === "withdrawn") {
      return { wait: await end("left", "withdrawn", String(u.output.reason ?? "")) };
    }
    // The approved change, on a new head: verified on its own before the approval carries over
    // (second review of #105). The item's Workflow verifies it and re-enters with the approval.
    if (state === "reverify") {
      return { wait: await end("left", "reverify", String(u.output.reason ?? "")) };
    }
    if (state === "held") {
      // At the bound: hold it and ask a person, never rebuild approved work (spec 53 review).
      const h = await call(env, lease, "mergeQueue.hold", {
        workItemId: id,
        reason: String(u.output.reason ?? ""),
      });
      if (h.status !== "ok") {
        return { wait: await end("left", "failed", `the babysitter couldn't ask: ${refusal(h)}`) };
      }
      const asked = String(h.output.state);
      if (asked === "resumed") return snapshot(); // one more update, now
      if (asked === "holding" && h.output.until) {
        return { wait: Math.max(0, Date.parse(String(h.output.until)) - clock().getTime()) };
      }
      return { wait: IDLE_RECHECK_MS }; // the answer wakes the queue
    }
    if (state !== "current" && state !== "updated") {
      return {
        wait: await end(
          "left",
          "failed",
          `the merge queue couldn't update the branch (${state}): ${String(u.output.reason ?? "")}`,
        ),
      };
    }
    return { at: String(u.output.headSha), state };
  };

  // A pass that marked the head merging and didn't finish: GitHub may have merged it. pr.merge
  // finds a merged PR merged (and records it), so land again at the same head before anything else.
  const snap = head.merging_at !== null ? { at: head.head_sha } : await snapshot();
  if ("wait" in snap) return snap.wait;
  const at = snap.at;

  // The head merges only on green CI there (ADR 0330): one the queue brought up to date, and one
  // a person approved again after a withdrawal (ADR 0582). An approved head's CI was green at
  // verify, so this read answers at once.
  if (head.merging_at === null) {
    const ci = await call(env, lease, "ci.read", { workItemId: id, headSha: at });
    const since = Date.parse(head.updated_at);
    const waited = clock().getTime() - (Number.isNaN(since) ? clock().getTime() : since);
    const ciState = ci.status === "ok" ? String(ci.output.state) : "unreadable";
    if (ci.status === "ok" && ci.output.mergeable === false) {
      return judge("conflict", at, [], "the default branch moved again and now conflicts");
    }
    if (ciState === "pending" && waited < CI_GIVE_UP_MS) return CI_RECHECK_MS;
    if (ciState === "missing" && waited < CI_MISSING_GIVE_UP_MS) return CI_RECHECK_MS;
    const reruns = await rerunsOn(env, head.repository_id, at);
    if (ciState === "failure" && ci.status === "ok") {
      const failing = (ci.output.failing as string[] | undefined) ?? [];
      // A check the babysitter already reran as a flake failed again: a regression, not a flake.
      const again = failing.find((f) => reruns.some((r) => r.check_name === f));
      if (again) {
        return end(
          "left",
          "failed",
          `${again} failed again on ${at.slice(0, 7)} after the babysitter reran it once: not a flake. Fix the branch against the latest default branch.`,
        );
      }
      return judge("check-failed", at, failing, `CI is failure on ${at.slice(0, 7)}`);
    }
    if (ciState === "success") {
      // Every rerun on this head passed: each is a known flake now (decision 3).
      for (const r of reruns.filter((x) => x.passed === null)) {
        await call(env, lease, "flake.record", {
          workItemId: id,
          headSha: at,
          check: r.check_name,
          deliveryFence: await currentFence(env, lease.key),
        });
      }
    }
    if (ciState !== "success") {
      return end(
        "left",
        "failed",
        `Merging the default branch into your branch broke CI (CI is ${ciState} on ${at.slice(0, 7)}, the branch with the default branch merged in). Fix the branch against the latest default branch.`,
      );
    }
  }

  // main may have turned red while CI ran on the updated head: hold it before the merge.
  if (await held(env, lease, head)) return HELD_RECHECK_MS;
  // Land it, at the head the queue recorded, with the approval (pr.merge stays ALWAYS_REVIEW).
  if (!head.pending_action_id) {
    return end("left", "failed", "the babysitter lands only an approved merge");
  }
  const touchesFactoryConfig = await approvedFlag(env, head.pending_action_id);
  // A head held while main was red (decision 7), or still waiting on CI the deliverer just read as
  // green, reads pending until it is evaluated again: evaluate it now, or pr.merge (and GitHub's
  // required check) would refuse the merge.
  await releaseHeld(env, lease, head, at);
  // Marked merging first, so a cancel from here until GitHub answers is refused ("this is
  // merging") rather than racing the merge (spec 53 review).
  await deliverTestSeams.beforeMark?.(id);
  const marked = await call(env, lease, "mergeQueue.merging", { workItemId: id, merging: true });
  if (marked.status !== "ok") {
    return end("left", "failed", `the babysitter couldn't start the merge: ${refusal(marked)}`);
  }
  await deliverTestSeams.beforeLand?.(id);
  const landed = await call(
    env,
    lease,
    "pr.merge",
    { workItemId: id, headSha: at, touchesFactoryConfig },
    { approvalId: head.pending_action_id, idempotencyKey: `deliver:${head.id}:merge:${at}` },
  );
  if (mergedForGood(landed)) return end("merged", "merged", "merged");
  const why = landed.status === "refused" ? landed.message : "still pending";
  // GitHub didn't merge: the mark goes, so the item can be cancelled again.
  await call(env, lease, "mergeQueue.merging", { workItemId: id, merging: false });
  // GitHub refused the merge itself (the default branch or the head moved since the snapshot):
  // never retried as is. pr.merge says so in `details.mergeRefused`, never only in its message.
  // Re-snapshot: a moved branch updates the head again (bounded) and CI runs there; a refusal with
  // nothing changed goes back (spec 53 review; asking a person is PR d's). A moved head is the
  // babysitter's to handle on a v11 item: pr.merge leaves the approval to it.
  const mergeRefused = landed.status === "refused" ? landed.details?.mergeRefused : undefined;
  // Verified, but its factory/verify hasn't caught up with CI yet (#190 review): wait, then retry,
  // as long as CI may take (UNVERIFIED_GIVE_UP_MS since verify passed on this head: the merging
  // mark moves the entry's updated_at every pass), then end.
  if (mergeRefused === "unverified" && landed.status === "refused" && landed.details?.pending) {
    const since = Date.parse(String(landed.details.passedAt ?? ""));
    // No time to measure from: don't wait on it at all.
    const waited = Number.isNaN(since) ? Number.POSITIVE_INFINITY : clock().getTime() - since;
    if (waited < UNVERIFIED_GIVE_UP_MS) return CI_RECHECK_MS;
    return end(
      "left",
      "failed",
      `factory/verify never became a success on ${at.slice(0, 7)}: ${why}`,
    );
  }
  if (mergeRefused === "headMoved" || mergeRefused === "refused") {
    const again = await snapshot();
    if ("wait" in again) return again.wait;
    if (again.state === "updated") return CI_RECHECK_MS;
    return end("left", "failed", `GitHub refused the merge and nothing had changed: ${why}`);
  }
  return end("left", "failed", `pr.merge failed after approval: ${why}`);
}

/**
 * Whether the head must wait: its repository's line is stopped and it isn't a repair. A stopped
 * line is re-read from GitHub (`main.observe`) before it holds anything, so one missed green webhook
 * costs at most one held recheck (HELD_RECHECK_MS), not the time until the next push.
 */
async function held(env: Env, lease: Lease, head: HeadRow): Promise<boolean> {
  if (head.repairs_main === 1) return false;
  const row = await env.DB.prepare(
    `SELECT h.red_since, r.owner, r.name FROM core_main_health h
     JOIN core_repositories r ON r.id = h.repository_id WHERE h.repository_id = ?`,
  )
    .bind(head.repository_id)
    .first<{ red_since: string | null; owner: string; name: string }>();
  if (!row?.red_since) return false;
  const seen = await call(env, lease, "main.observe", {
    repo: { owner: row.owner, name: row.name },
    headSha: null,
    trigger: "recheck",
  });
  // Unreadable: stay held (fail closed); the next recheck tries again.
  if (seen.status !== "ok") return true;
  return seen.output.redSince !== null;
}

/**
 * When a delivery counts as merged, and its item Done (spec 53, decision 6, 2026-11-13): when its
 * merge commit is on the default branch. GitHub answering the merge with success means the commit
 * is there. A red `main` afterwards makes the item a suspect; it doesn't undo Done.
 */
function mergedForGood(landed: Called): boolean {
  return landed.status === "ok";
}

const refusal = (c: Called) =>
  c.status === "refused" ? `${c.code}: ${c.message}` : "awaiting approval";

/** Whether the merge approval was already used (pr.merge consumed it in its own batch). */
async function approvalUsed(env: Env, pendingActionId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT status FROM core_pending_actions WHERE id = ?")
    .bind(pendingActionId)
    .first<{ status: string }>();
  return row?.status === "applied";
}

/** The approved `pr.merge` input's `touchesFactoryConfig`: the approval binds the risk it was given. */
async function approvedFlag(env: Env, pendingActionId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT input FROM core_pending_actions WHERE id = ?")
    .bind(pendingActionId)
    .first<{ input: string }>();
  try {
    return (
      (JSON.parse(String(row?.input ?? "{}")) as { touchesFactoryConfig?: unknown })
        .touchesFactoryConfig === true
    );
  } catch {
    return false;
  }
}

interface BabysitStateRow {
  babysit_job_id: string | null;
  babysit_fence: number;
  babysit_reasons: string;
}

async function babysitState(env: Env, key: string): Promise<BabysitStateRow | null> {
  // core_delivery_state's primary key.
  return env.DB.prepare(
    "SELECT babysit_job_id, babysit_fence, babysit_reasons FROM core_delivery_state WHERE key = ?",
  )
    .bind(key)
    .first<BabysitStateRow>();
}

async function currentFence(env: Env, key: string): Promise<number> {
  return (await babysitState(env, key))?.babysit_fence ?? 0;
}

/** Reruns the babysitter asked for on a head (core_ci_reruns' primary key prefix). */
async function rerunsOn(
  env: Env,
  repositoryId: string,
  headSha: string,
): Promise<{ check_name: string; passed: number | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT check_name, passed FROM core_ci_reruns WHERE repository_id = ? AND head_sha = ? LIMIT 20",
  )
    .bind(repositoryId, headSha)
    .all<{ check_name: string; passed: number | null }>();
  return results;
}

type Settled =
  | { kind: "wait"; ms: number }
  | { kind: "end"; delivery: "conflict" | "failed" | "withdrawn"; reason: string }
  | { kind: "go" };

/**
 * Acts on the repository's `babysit` job once it is over (spec 53 §4, ADR 0585). Its verdict
 * leads to code, never to anything the agent does itself: a flake is rerun once (`ci.rerun`), a
 * resolution moves the item's branch (`branch.advance`) and withdraws the approval, anything else
 * ends the delivery with the job's note. A job that died is replaced once by a fresh job with a
 * higher fence (whose late writes the old one can't make), then the delivery ends.
 */
async function settleBabysit(
  env: Env,
  lease: Lease,
  head: HeadRow,
  sitter: BabysitStateRow,
): Promise<Settled> {
  // core_jobs' and core_runs' primary keys.
  const job = await env.DB.prepare(
    `SELECT j.status, j.context, j.work_item_id, j.wait_reason, j.created_at, r.id AS run_id,
            r.result, r.head_sha
     FROM core_jobs j LEFT JOIN core_runs r ON r.id = j.run_id WHERE j.id = ?`,
  )
    .bind(sitter.babysit_job_id)
    .first<{
      status: string;
      wait_reason: string | null;
      created_at: string;
      context: string;
      work_item_id: string;
      run_id: string | null;
      result: string | null;
      head_sha: string | null;
    }>();
  const context = parseJson<{ reason?: BabysitReason; deliveryFence?: number }>(job?.context, {});
  const fence = context.deliveryFence ?? sitter.babysit_fence;
  const itemId = job?.work_item_id ?? head.work_item_id;
  const next = async (cancel = false): Promise<boolean> => {
    const closed = await call(env, lease, "babysit.next", {
      workItemId: itemId,
      deliveryFence: fence,
      cancel,
    });
    // A cancel refused because a runner claimed the job just now: the job stands.
    if (closed.status === "refused" && cancel) return false;
    if (closed.status === "refused") throw new Error(`babysit.next refused: ${closed.message}`);
    return true;
  };
  // Still to be claimed or at work. With no runner online that can babysit (an older runner can't:
  // ADR 0620), it doesn't wait for ever: past BABYSIT_RECHECK_MS the job is cancelled and the
  // delivery ends saying so, as it did before the babysitter (a person sees why on the item).
  if (job && (job.status === "queued" || job.status === "claimed")) {
    const waited = Date.now() - Date.parse(job.created_at);
    const reason = context.reason;
    // No runner said why (none online at all claims anything): the job's age bounds the wait.
    const why =
      job.wait_reason === NO_BABYSIT_RUNNER && waited >= BABYSIT_RECHECK_MS
        ? NO_BABYSIT_RUNNER
        : waited >= BABYSIT_UNCLAIMED_MS
          ? `no runner claimed the babysit job in ${BABYSIT_UNCLAIMED_MS / 60_000} minutes`
          : null;
    if (job.status === "queued" && why && reason) {
      if (!(await next(true))) return { kind: "wait", ms: BABYSIT_RECHECK_MS };
      // The job was another item's (it left the head meanwhile): closed, and the head goes on; the
      // head is never ended for another item's job (sixth review of #185).
      if (job.work_item_id !== head.work_item_id) return { kind: "go" };
      return {
        kind: "end",
        delivery: reason.kind === "conflict" ? "conflict" : "failed",
        reason: `${why}: the ${reason.kind === "conflict" ? "conflict" : `failing check (${reason.checks.join(", ") || "CI"})`} on ${reason.headSha.slice(0, 7)} needs a person`,
      };
    }
    return { kind: "wait", ms: BABYSIT_RECHECK_MS };
  }
  const reason = context.reason;
  // A job for an item no longer at the head (it left meanwhile): closed, nothing acted on.
  if (!job || !reason || job.work_item_id !== head.work_item_id || fence !== sitter.babysit_fence) {
    await next();
    return { kind: "go" };
  }
  const result = job.status === "done" ? babysitResult(job.result) : null;
  const ending = reason.kind === "conflict" ? "conflict" : "failed";
  if (!result) {
    await next();
    // Died (lease expired, runner gone) or handed back nothing usable: one fresh job, then stop.
    if (reason.attempt < 2) {
      const again = await call(env, lease, "babysit.wake", {
        workItemId: head.work_item_id,
        reason: { kind: reason.kind, headSha: reason.headSha, checks: reason.checks, attempt: 2 },
      });
      if (again.status === "ok") return { kind: "wait", ms: BABYSIT_RECHECK_MS };
    }
    return {
      kind: "end",
      delivery: ending,
      reason: `the babysitter couldn't decide the ${reason.kind} on ${reason.headSha.slice(0, 7)} (its job ${job.status})`,
    };
  }
  if (reason.kind === "conflict") {
    if (result.verdict === "resolved" && job.run_id && job.head_sha) {
      const moved = await call(env, lease, "branch.advance", {
        workItemId: head.work_item_id,
        runId: job.run_id,
      });
      await next();
      if (moved.status === "ok" && moved.output.ok === true) {
        // What the person reviews at the reopened gate: only the resolution (decision 1). A
        // failure to read it doesn't block: the gate then shows the whole head.
        // It records a failed read itself; a refusal here (a stale fence) leaves nothing, and the
        // gate then has no resolution to show, so it shows the whole diff.
        await call(env, lease, "babysit.resolution", {
          workItemId: head.work_item_id,
          headSha: job.head_sha,
          approvedHead: reason.headSha,
          deliveryFence: fence,
        });
        // A new head: the approval no longer holds. The item verifies it, and a person approves
        // the resolution (decision 1).
        return {
          kind: "end",
          delivery: "withdrawn",
          reason: `the babysitter resolved a conflict with the default branch in ${job.head_sha.slice(0, 7)}: review the resolution. ${result.note}`,
        };
      }
      const why = moved.status === "ok" ? String(moved.output.reason ?? "") : refusal(moved);
      return {
        kind: "end",
        delivery: "conflict",
        reason: `the babysitter's resolution couldn't be moved onto the branch (${why})`,
      };
    }
    await next();
    return {
      kind: "end",
      delivery: "conflict",
      reason: `the babysitter left the conflict for a person: ${result.note}`,
    };
  }
  // check-failed
  const check = result.check ?? reason.checks[0];
  if (result.verdict === "flake" && check) {
    const rerun = await call(env, lease, "ci.rerun", {
      workItemId: head.work_item_id,
      headSha: reason.headSha,
      check,
      ...(result.test ? { test: result.test } : {}),
      deliveryFence: fence,
    });
    await next();
    if (rerun.status === "ok") return { kind: "wait", ms: CI_RECHECK_MS };
    return {
      kind: "end",
      delivery: "failed",
      reason: `${check} failed on ${reason.headSha.slice(0, 7)} and couldn't be rerun (${refusal(rerun)})`,
    };
  }
  await next();
  return {
    kind: "end",
    delivery: "failed",
    reason:
      result.verdict === "regression"
        ? `${check ?? "a required check"} failed on ${reason.headSha.slice(0, 7)} after the update, and the babysitter judged it a regression: ${result.note}`
        : `${check ?? "a required check"} failed on ${reason.headSha.slice(0, 7)} after the update; the babysitter asks a person: ${result.note}`,
  };
}

/**
 * When `factory/verify` on the head still says "held: main is red" (main went green and the
 * re-evaluation hasn't run yet), or still waits for CI that the deliverer has just read as green
 * (the check-suite webhook not processed yet), evaluates it again now: pr.merge requires it to be a
 * success on this exact head (#190 review). Primary-key reads: core_verify_checks
 * (project_id, head_sha), then the item and its repository.
 */
async function releaseHeld(env: Env, lease: Lease, head: HeadRow, at: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT v.held_at, v.status, r.owner, r.name, w.pr_number FROM core_verify_checks v
     JOIN core_work_items w ON w.id = ?3
     JOIN core_repositories r ON r.id = w.repository_id
     WHERE v.project_id = ?1 AND v.head_sha = ?2`,
  )
    .bind(head.project_id, at, head.work_item_id)
    .first<{
      held_at: string | null;
      status: string;
      owner: string;
      name: string;
      pr_number: number | null;
    }>();
  if (!row || (!row.held_at && row.status === "completed")) return;
  await call(env, lease, "verify.refresh", {
    repo: { owner: row.owner, name: row.name },
    headSha: at,
    prNumber: row.pr_number,
    trigger: "rerequested",
  });
}
