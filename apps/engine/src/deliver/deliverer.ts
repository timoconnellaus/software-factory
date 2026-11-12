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
import { BABYSITTER, invoke, isOperationError } from "@software-factory/core";
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
/** A queue whose head is someone else's (a v4–v7 Workflow) or empty: a slow safety look. */
const IDLE_RECHECK_MS = 60 * 60_000;
/** Rounds of one wake: a pass, then again while something changed meanwhile. */
const ROUNDS = 5;
/**
 * Update-branch requests per entry: a default branch that keeps moving while CI runs gets the head
 * updated (and CI'd) at most this many times, then the item goes back (spec 53 review).
 */
export const MAX_UPDATES = 3;

/** Test seam only: called after CI was read green and before pr.merge (deterministic races). */
export const deliverTestSeams: { beforeLand: ((workItemId: string) => Promise<void>) | null } = {
  beforeLand: null,
};

/** The pass's lease on its repository: sent with every operation it calls. */
interface Lease {
  key: string;
  rev: number;
}

/** Another pass took the repository over: this one stops, changing nothing more. */
class LeaseLost extends Error {}

interface HeadRow {
  id: string;
  work_item_id: string;
  pending_action_id: string | null;
  approved_sha: string;
  head_sha: string;
  driver: "workflow" | "babysitter";
  update_asked_at: string | null;
  updated_at: string;
  item_status: string;
  number: number;
}

type Called =
  | { status: "ok"; output: Record<string, unknown> }
  | { status: "pending"; pendingActionId: string }
  | { status: "refused"; code: string; message: string };

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
    const waitMs = await deliverHead(env, lease, head, clock);
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
            q.update_asked_at, q.updated_at, w.status AS item_status, w.number
     FROM core_merge_queue q JOIN core_work_items w ON w.id = q.work_item_id
     WHERE q.project_id = ?1 AND q.status = 'queued'
       AND w.status IN ('running', 'waiting', 'paused')
       AND w.repository_id = ?2
     ORDER BY q.enqueued_at ASC, q.id ASC LIMIT 1`,
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
    return { status: "refused", code: error.code, message: error.message };
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
    delivery: "merged" | "conflict" | "failed",
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
      return { wait: await end("left", "conflict", String(u.output.reason ?? "conflict")) };
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

  const snap = await snapshot();
  if ("wait" in snap) return snap.wait;
  const at = snap.at;

  // A head the queue brought up to date merges only on green CI there (ADR 0330).
  if (at !== head.approved_sha) {
    const ci = await call(env, lease, "ci.read", { workItemId: id, headSha: at });
    const since = Date.parse(head.updated_at);
    const waited = clock().getTime() - (Number.isNaN(since) ? clock().getTime() : since);
    const ciState = ci.status === "ok" ? String(ci.output.state) : "unreadable";
    if (ci.status === "ok" && ci.output.mergeable === false) {
      return end("left", "conflict", "the default branch moved again and now conflicts");
    }
    if (ciState === "pending" && waited < CI_GIVE_UP_MS) return CI_RECHECK_MS;
    if (ciState === "missing" && waited < CI_MISSING_GIVE_UP_MS) return CI_RECHECK_MS;
    if (ciState !== "success") {
      return end(
        "left",
        "failed",
        `Merging the default branch into your branch broke CI (CI is ${ciState} on ${at.slice(0, 7)}, the branch with the default branch merged in). Fix the branch against the latest default branch.`,
      );
    }
  }

  // Land it, at the head the queue recorded, with the approval (pr.merge stays ALWAYS_REVIEW).
  if (!head.pending_action_id) {
    return end("left", "failed", "the babysitter lands only an approved merge");
  }
  const touchesFactoryConfig = await approvedFlag(env, head.pending_action_id);
  await deliverTestSeams.beforeLand?.(id);
  const landed = await call(
    env,
    lease,
    "pr.merge",
    { workItemId: id, headSha: at, touchesFactoryConfig },
    { approvalId: head.pending_action_id, idempotencyKey: `deliver:${head.id}:merge:${at}` },
  );
  if (landed.status === "ok") return end("merged", "merged", "merged");
  const why = landed.status === "refused" ? landed.message : "still pending";
  // GitHub refused the merge itself (the default branch moved since the snapshot): never retried as
  // is. Re-snapshot: a moved default branch updates the head again (bounded) and CI runs there; a
  // refusal with nothing changed goes back (spec 53 review; asking a person is PR d's).
  if (landed.status === "refused" && landed.code === "conflict" && /merge refused/.test(why)) {
    const again = await snapshot();
    if ("wait" in again) return again.wait;
    if (again.state === "updated") return CI_RECHECK_MS;
    return end("left", "failed", `GitHub refused the merge and nothing had changed: ${why}`);
  }
  return end("left", "failed", `pr.merge failed after approval: ${why}`);
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
