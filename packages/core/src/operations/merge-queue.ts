// The merge queue (ADR 0330, spec 06): approved merges land one at a time per project, so each PR
// runs CI once, against the default branch it will land on. A work item enters after its merge is
// approved (or for a check-only incident fix, before auto-merge is tried). Only the head of the
// queue is brought up to date (GitHub's update-branch: a clean merge of the default branch into the
// approved head) and merged; nothing else lands while its CI runs. A conflict, or red CI after the
// update, takes the item out of the queue and back to build. pr.merge and pr.autoMerge refuse a
// queued item that isn't the head, or a head the queue didn't bring there.
import type {
  CoreDatabase,
  DeliveryOutcome,
  MergeQueueDriver,
  MergeQueueStatus,
} from "@software-factory/db";
import { type Selectable, sql } from "kysely";
import { z } from "zod";
import { BABYSITTER } from "../actors.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import {
  defineOperation,
  type HandlerContext,
  type ProjectRow,
  type RepositoryRow,
  type WorkItemRow,
} from "../operation.ts";
import type { RepoRef } from "../services.ts";
import {
  approvalSurvivesMergeOfMain,
  changeDigest,
  onlyEitherSide,
} from "../verify/change-digest.ts";
import { deliveredEvent, mergeQueueEvent } from "../workflow-events.ts";
import { askOne } from "./ask.ts";
import { lineStopped } from "./delivery.ts";
import {
  pendingActionId,
  projectId,
  repoRef,
  requireProject,
  requireRepository,
  requireWorkItem,
  sha,
  workItemId,
} from "./shared.ts";
import { carryReviewPacket } from "./verify.ts";

/** Work item statuses whose queue entry still counts (an ended item never holds the head). */
const OPEN_ITEM = ["running", "waiting", "paused"] as const;

interface QueueRow {
  id: string;
  work_item_id: string;
  workflow_id: string | null;
  pending_action_id: string | null;
  approved_sha: string;
  head_sha: string;
  enqueued_at: string;
  number: number;
  title: string;
  repository_id: string | null;
  driver: MergeQueueDriver;
  repairs_main: number;
}

/**
 * The project's open entries, head first, as one query (for `readBatch`). An entry whose work item
 * ended is skipped. With `repositoryId`, only that repository's queue (ADR 0490).
 */
export function queuedEntriesQuery(
  ctx: HandlerContext,
  project: string,
  repositoryId?: string | null,
) {
  return (
    ctx.db
      .selectFrom("core_merge_queue as q")
      .innerJoin("core_work_items as w", "w.id", "q.work_item_id")
      .select([
        "q.id",
        "q.work_item_id",
        "q.workflow_id",
        "q.pending_action_id",
        "q.approved_sha",
        "q.head_sha",
        "q.enqueued_at",
        "q.driver",
        "w.number",
        "w.title",
        "w.repository_id",
        "w.repairs_main",
      ])
      .where("q.project_id", "=", project)
      // One queue per repository (ADR 0490): an item lands on its own repository's default branch.
      // An item with no repository recorded (code from before 0260) shares its project's queue: a
      // project has one repository until per-repository protection lands.
      .$if(typeof repositoryId === "string", (q) =>
        q.where("w.repository_id", "=", repositoryId ?? ""),
      )
      .where("q.status", "=", "queued")
      .where("w.status", "in", [...OPEN_ITEM])
      // A repair of a red default branch goes first, only while it is red (spec 53, ADR 0581): it
      // is what may land then. A primary-key lookup per open entry.
      .orderBy(
        sql`(w.repairs_main = 1 AND EXISTS (SELECT 1 FROM core_main_health h WHERE h.repository_id = w.repository_id AND h.red_since IS NOT NULL))`,
        "desc",
      )
      .orderBy("q.enqueued_at", "asc")
      .orderBy("q.id", "asc")
  );
}

/** The project's open entries, head first. */
export async function queuedEntries(
  ctx: HandlerContext,
  project: string,
  repositoryId?: string | null,
): Promise<QueueRow[]> {
  return queuedEntriesQuery(ctx, project, repositoryId).execute();
}

/** The work item's open entry, if it has one. */
export async function openEntry(ctx: HandlerContext, item: string) {
  return (
    (await ctx.db
      .selectFrom("core_merge_queue")
      .selectAll()
      .where("work_item_id", "=", item)
      .where("status", "=", "queued")
      .executeTakeFirst()) ?? null
  );
}

/**
 * Ends the work item's open entry (merged, or left the queue) and wakes whoever is head after it.
 * A no-op without an entry. Used by mergeQueue.leave and when a work item finishes or is cancelled.
 */
export async function releaseMergeQueue(
  ctx: HandlerContext,
  item: Pick<WorkItemRow, "id" | "project_id" | "repository_id">,
  status: Exclude<MergeQueueStatus, "queued">,
  reason: string,
  /** How the babysitter's delivery ended (spec 53): told to the item's Workflow. */
  outcome?: DeliveryOutcome,
): Promise<boolean> {
  const entry = await openEntry(ctx, item.id);
  if (!entry) return false;
  // A delivery that ends without the babysitter saying how (the item finished or was cancelled)
  // ended as `failed`; the Workflow is gone or going by then.
  const told: DeliveryOutcome | null =
    entry.driver === "babysitter" ? (outcome ?? (status === "merged" ? "merged" : "failed")) : null;
  ctx.write(
    ctx.db
      .updateTable("core_merge_queue")
      .set({
        status,
        end_reason: reason,
        ended_at: ctx.now,
        updated_at: ctx.now,
        outcome: told,
      })
      .where("id", "=", entry.id)
      .where("status", "=", "queued"),
  );
  ctx.change({
    entity: "merge_queue",
    id: entry.id,
    before: { status: "queued" },
    after: { status, reason },
  });
  if (told && entry.workflow_id) {
    ctx.emit({
      kind: "workflow.event",
      payload: {
        instanceId: entry.workflow_id,
        type: deliveredEvent(item.id),
        payload: { outcome: told, reason, headSha: entry.head_sha },
      },
    });
  }
  const next = (await queuedEntries(ctx, item.project_id, item.repository_id)).find(
    (e) => e.work_item_id !== item.id,
  );
  // The next head may be the babysitter's to land (spec 53).
  if (next?.driver === "babysitter") wakeDelivery(ctx, item);
  if (next?.workflow_id && next.driver === "workflow") {
    ctx.emit({
      kind: "workflow.event",
      payload: {
        instanceId: next.workflow_id,
        type: mergeQueueEvent(next.work_item_id),
        payload: { head: true },
      },
    });
  }
  return true;
}

/** Asks the babysitter's deliverer to look at the item's repository queue once this call commits. */
export function wakeDelivery(
  ctx: HandlerContext,
  item: Pick<WorkItemRow, "project_id" | "repository_id">,
): void {
  if (!item.repository_id) return; // never the babysitter's (ADR 0586)
  ctx.emit({
    kind: "delivery.wake",
    payload: { projectId: item.project_id, repositoryId: item.repository_id },
  });
}

/**
 * What pr.merge / pr.autoMerge require of a queued item (ADR 0330): it is the head of its
 * project's queue and `headSha` is the head the queue recorded. An item that never queued (a
 * Workflow from before v4) isn't held to it.
 */
export async function requireQueueHead(
  ctx: HandlerContext,
  item: WorkItemRow,
  headSha: string,
): Promise<void> {
  const entry = await openEntry(ctx, item.id);
  if (!entry) return;
  const head = (await queuedEntries(ctx, item.project_id, item.repository_id))[0];
  if (head?.work_item_id !== item.id) {
    throw new OperationError(
      "conflict",
      `not the head of the merge queue: #${head?.number ?? "?"} lands first (ADR 0330)`,
    );
  }
  if (entry.head_sha !== headSha) {
    throw new OperationError(
      "conflict",
      `the merge queue's head for this item is ${entry.head_sha.slice(0, 7)}, not ${headSha.slice(0, 7)}`,
    );
  }
}

/**
 * What pr.merge requires beyond the queue's head (spec 53 review): the item is still open, and a
 * merge by the babysitter is of an entry still open in its queue. Read now, before GitHub is asked,
 * and guarded in the call's batch, so a cancel, a finish or a leave that commits first refuses it.
 */
export async function requireOpenToMerge(ctx: HandlerContext, item: WorkItemRow): Promise<void> {
  if (!(OPEN_ITEM as readonly string[]).includes(item.status)) {
    throw new OperationError("conflict", `work item #${item.number} is ${item.status}: not merged`);
  }
  ctx.guardExists(
    "item open",
    ctx.db
      .selectFrom("core_work_items")
      .select("id")
      .where("id", "=", item.id)
      .where("status", "in", [...OPEN_ITEM]),
  );
  if (ctx.actor.type !== BABYSITTER.type || ctx.actor.id !== BABYSITTER.id) return;
  const entry = await openEntry(ctx, item.id);
  if (entry?.driver !== "babysitter") {
    throw new OperationError(
      "conflict",
      `work item #${item.number} is not in the babysitter's queue`,
    );
  }
  ctx.guardExists(
    "entry open",
    ctx.db
      .selectFrom("core_merge_queue")
      .select("id")
      .where("id", "=", entry.id)
      .where("status", "=", "queued"),
  );
}

const position = z.object({
  queued: z.boolean(),
  entryId: z.string().nullable(),
  /** 1 is the head. Null when not queued. */
  position: z.number().nullable(),
  head: z.boolean(),
  /** The work item numbers ahead of this one, head first. */
  ahead: z.array(z.number()),
  headSha: z.string().nullable(),
  /** Who lands it: its own Workflow, or the babysitter (spec 53). Null when not queued. */
  driver: z.enum(["workflow", "babysitter"]).nullable(),
  /**
   * When not queued: how its last babysitter delivery ended, and why (spec 53), so a Workflow that
   * missed the `delivered-<item>` event reads it back. Null otherwise.
   */
  outcome: z.enum(["merged", "conflict", "failed", "withdrawn", "reverify"]).nullable(),
  outcomeReason: z.string().nullable(),
  /**
   * Held (spec 53, ADR 0581): the default branch is red and this isn't a repair, so the babysitter
   * won't land it until it is green. Null otherwise.
   */
  held: z.object({ since: z.string(), failing: z.array(z.string()) }).nullable(),
});

async function positionOf(
  ctx: HandlerContext,
  item: WorkItemRow,
): Promise<z.infer<typeof position>> {
  const entries = await queuedEntries(ctx, item.project_id, item.repository_id);
  const i = entries.findIndex((e) => e.work_item_id === item.id);
  if (i < 0) {
    const last = await ctx.db
      .selectFrom("core_merge_queue")
      .select(["id", "outcome", "end_reason", "head_sha"])
      .where("work_item_id", "=", item.id)
      .orderBy("enqueued_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return {
      queued: false,
      entryId: last?.outcome ? last.id : null,
      position: null,
      head: false,
      ahead: [],
      // The head it ended at: for `withdrawn`, the head to decide again (ADR 0582).
      headSha: last?.outcome ? last.head_sha : null,
      driver: null,
      outcome: last?.outcome ?? null,
      outcomeReason: last?.outcome ? last.end_reason : null,
      held: null,
    };
  }
  const entry = entries[i] as QueueRow;
  const stopped =
    entry.driver === "babysitter" && entry.repairs_main !== 1 ? await lineStopped(ctx, item) : null;
  return {
    queued: true,
    entryId: entry.id,
    position: i + 1,
    head: i === 0,
    ahead: entries.slice(0, i).map((e) => e.number),
    headSha: entry.head_sha,
    driver: entry.driver,
    outcome: null,
    outcomeReason: null,
    held: stopped ? { since: stopped.since, failing: stopped.failing } : null,
  };
}

export const mergeQueueEnter = defineOperation({
  name: "mergeQueue.enter",
  description:
    "Put a work item in its project's merge queue (ADR 0330), after its merge was approved (`pendingActionId`) or, for a check-only incident fix, before auto-merge is tried. Approved merges land one at a time: only the head is brought up to date with the default branch and merged. A repeat returns the open entry.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    headSha: sha,
    pendingActionId: pendingActionId.nullable(),
    /**
     * Who lands it (spec 53): `workflow`, the item's own Workflow (v4–v7, the default); or
     * `babysitter`, the engine's deliverer (v11), which needs the approval to land with.
     */
    driver: z.enum(["workflow", "babysitter"]).default("workflow"),
  }),
  output: position,
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (input.driver === "babysitter" && !input.pendingActionId) {
      throw new OperationError("invalid_input", "the babysitter lands only an approved merge");
    }
    // The babysitter's queues are per repository (one lease each, ADR 0586); an item with no
    // repository can't merge anyway (pr.merge needs one).
    if (input.driver === "babysitter" && !w.repository_id) {
      throw new OperationError("conflict", "the babysitter lands only an item with a repository");
    }
    if (!w.pr_number) throw new OperationError("conflict", "no pull request");
    if (w.head_sha !== input.headSha) {
      throw new OperationError("conflict", "the branch moved since the review packet was made");
    }
    const existing = await openEntry(ctx, w.id);
    if (!existing) {
      // The change this approval is about (ADR 0582), so a merge of the default branch keeps it
      // only while the change is the same. Read by the engine from GitHub, never a runner.
      let approvedDigest =
        input.driver === "babysitter" ? await digestOf(ctx, input.headSha) : null;
      // An approval carried over a clean merge of the default branch (`reverify`, ADR 0582) comes
      // back only for the change it approved: the new head's digest must be the approved one, and
      // the entry keeps that digest, never one computed from the new head alone.
      const carried =
        input.driver === "babysitter" && input.pendingActionId
          ? await ctx.db
              .selectFrom("core_merge_queue")
              .select(["approved_digest", "updates", "updates_granted"])
              .where("work_item_id", "=", w.id)
              .where("pending_action_id", "=", input.pendingActionId)
              .where("outcome", "=", "reverify")
              .orderBy("enqueued_at", "desc")
              .limit(1)
              .executeTakeFirst()
          : undefined;
      if (carried) {
        if (!carried.approved_digest || carried.approved_digest !== approvedDigest) {
          throw new OperationError(
            "conflict",
            "the change is not the one approved: the carried approval doesn't hold for this head",
          );
        }
        approvedDigest = carried.approved_digest;
      }
      const id = newId("mergeQueueEntry");
      ctx.write(
        ctx.db.insertInto("core_merge_queue").values({
          id,
          project_id: w.project_id,
          work_item_id: w.id,
          workflow_id: w.workflow_id,
          pending_action_id: input.pendingActionId,
          approved_sha: input.headSha,
          head_sha: input.headSha,
          enqueued_at: ctx.now,
          updated_at: ctx.now,
          driver: input.driver,
          approved_digest: approvedDigest,
          // The bound on updates holds across the re-verification: main that keeps moving reaches
          // it and a person is asked, rather than re-verifying for ever.
          ...(carried
            ? { updates: carried.updates, updates_granted: carried.updates_granted }
            : {}),
        }),
      );
      if (input.driver === "babysitter") wakeDelivery(ctx, w);
      ctx.change({
        entity: "merge_queue",
        id,
        after: { status: "queued", headSha: input.headSha },
      });
      // The position read below runs before this write commits: count this entry at the back.
      const entries = await queuedEntries(ctx, w.project_id, w.repository_id);
      return {
        queued: true,
        entryId: id,
        position: entries.length + 1,
        head: entries.length === 0,
        ahead: entries.map((e) => e.number),
        headSha: input.headSha,
        driver: input.driver,
        outcome: null,
        outcomeReason: null,
        held: null,
      };
    }
    return positionOf(ctx, w);
  },
});

export const mergeQueuePosition = defineOperation({
  name: "mergeQueue.position",
  description:
    "Where a work item stands in its project's merge queue (ADR 0330): queued or not, its position (1 is the head, which lands next), the work items ahead of it, and the head SHA the queue has for it.",
  risk: "read",
  actors: ["agent", "human"],
  permission: "member",
  input: z.object({ workItemId }),
  output: position,
  async handler(_input, ctx) {
    return positionOf(ctx, requireWorkItem(ctx));
  },
});

export const mergeQueueList = defineOperation({
  name: "mergeQueue.list",
  description:
    "A project's merge queue (ADR 0330), head first: each approved work item waiting to land, with its number, title, the head the queue has for it and when it entered.",
  // Polled: reads nothing an org workflow decides (spec 52 PR (d), cost).
  skipsOrgWorkflow: true,
  risk: "read",
  actors: ["agent", "human"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({
    entries: z.array(
      z.object({
        workItemId: z.string(),
        number: z.number(),
        title: z.string(),
        headSha: z.string(),
        enqueuedAt: z.string(),
        /** The repository it lands in: the queue is per repository (ADR 0490). */
        repositoryId: z.string().nullable(),
      }),
    ),
  }),
  async handler(_input, ctx) {
    const entries = await queuedEntries(ctx, requireProject(ctx).id);
    return {
      entries: entries.map((e) => ({
        workItemId: e.work_item_id,
        number: e.number,
        title: e.title,
        headSha: e.head_sha,
        enqueuedAt: e.enqueued_at,
        repositoryId: e.repository_id,
      })),
    };
  },
});

export const mergeQueueUpdate = defineOperation({
  name: "mergeQueue.update",
  description:
    "Bring the head of the merge queue up to date with the default branch (ADR 0330). `current`: it already contains the default branch. `updating`: GitHub was asked to merge the default branch in (update-branch); call again to see the result. `updated`: GitHub made that clean merge; the review packet carries over to the new head and CI runs there. `conflict`: the default branch can't merge in cleanly (back to build). `refused`/`moved`: GitHub refused, or the head moved some other way. `held`: the babysitter's bound on updates was reached (`mergeQueue.hold` asks a person). Only the head may update. Risk `write`, like the control plane's other moves of a work item's branch.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    /**
     * At most this many update-branch requests for the entry (spec 53 review: a default branch
     * that keeps moving while CI runs must not keep the head updating). Past it (plus the updates a
     * person granted, `mergeQueue.hold`), a head that is behind is `held` without asking GitHub. Omitted: no bound (v4–v7's Workflows).
     */
    maxUpdates: z.number().int().positive().optional(),
  }),
  output: z.object({
    state: z.enum([
      "current",
      "updating",
      "updated",
      "withdrawn",
      "conflict",
      "refused",
      "moved",
      "held",
      "reverify",
    ]),
    headSha: z.string(),
    reason: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const project = requireProject(ctx);
    const entry = await openEntry(ctx, w.id);
    if (!entry) throw new OperationError("conflict", "not in the merge queue");
    const head = (await queuedEntries(ctx, w.project_id, w.repository_id))[0];
    if (head?.work_item_id !== w.id) {
      throw new OperationError("conflict", "only the head of the merge queue is updated");
    }
    if (!w.pr_number) throw new OperationError("conflict", "no pull request");
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const github = ctx.services.github;
    const at = entry.head_sha;
    const pr = await github.pullRequestMergeability(repo, w.pr_number);
    const prHead = pr.headSha ?? at;

    if (prHead !== at)
      return acceptUpdate(ctx, {
        w,
        project,
        repository,
        repo,
        entry,
        requestedFrom: entry.update_from_sha,
        at,
        prHead,
      });

    const behind = (await github.compareCommits(repo, repository.default_branch, at)).behindBy;
    if (behind === 0) return { state: "current" as const, headSha: at, reason: null };
    if (pr.mergeable === false) {
      return {
        state: "conflict" as const,
        headSha: at,
        reason: `${repository.default_branch} can't merge into the branch cleanly`,
      };
    }
    // At the bound (plus what a person granted) the head is held, never sent back: the babysitter
    // asks a person whether to update once more (spec 53 review, `mergeQueue.hold`).
    if (
      input.maxUpdates !== undefined &&
      entry.updates >= input.maxUpdates + entry.updates_granted
    ) {
      return {
        state: "held" as const,
        headSha: at,
        reason: `${repository.default_branch} keeps moving: this branch was updated ${entry.updates} times`,
      };
    }
    const mainHead = await github.getBranchSha(repo, repository.default_branch);
    const asked = await github.updatePullRequestBranch(repo, {
      number: w.pr_number,
      expectedHeadSha: at,
    });
    if (asked.status === "requested") {
      // When it was asked, so the babysitter knows how long GitHub has been at it (spec 53).
      ctx.write(
        ctx.db
          .updateTable("core_merge_queue")
          .set((eb) => ({
            update_asked_at: ctx.now,
            updates: eb("updates", "+", 1),
            // The request, so only the merge it asked for is accepted (spec 53 review): the head
            // GitHub merges into, and the default branch's head when asked.
            update_from_sha: at,
            update_base_sha: mainHead,
          }))
          .where("id", "=", entry.id),
      );
      // GitHub makes the merge commit asynchronously; it is often there already.
      const after = (await github.pullRequestMergeability(repo, w.pr_number)).headSha;
      if (after && after !== at) {
        return acceptUpdate(ctx, {
          w,
          project,
          repository,
          repo,
          entry,
          requestedFrom: at,
          at,
          prHead: after,
        });
      }
      ctx.change({
        entity: "work_item",
        id: w.id,
        after: {
          mergeQueue: `asked GitHub to merge ${repository.default_branch} in (${behind} behind)`,
        },
      });
      return { state: "updating" as const, headSha: at, reason: null };
    }
    return { state: asked.status, headSha: at, reason: asked.reason };
  },
});

/**
 * The head moved after the queue asked GitHub to update it. Accepted only as the merge the factory
 * asked for (spec 53 review): GitHub's update-branch merge (made and signed by GitHub) of the
 * default branch into the head the request was made from, with exactly those two parents and the
 * second on the default branch. Anything else is a push the queue didn't make: `moved` for an item
 * that lands itself (v4–v7, ADR 0330), and for the babysitter `withdrawn`.
 *
 * For the babysitter the approval is about the change (ADR 0582, owner question 1 as recommended):
 * it carries over only when the merge holds nothing but its two parents' files and the change is
 * identical (`approvalSurvivesMergeOfMain`). Any doubt withdraws it: the approval is closed, the
 * review packet is not carried and `factory/verify` is not posted on the new head, so nobody can
 * merge it on GitHub either; the item verifies the new head again (Workflow v12).
 */
async function acceptUpdate(
  ctx: HandlerContext,
  args: {
    w: WorkItemRow;
    project: ProjectRow;
    repository: RepositoryRow;
    repo: RepoRef;
    entry: Selectable<CoreDatabase["core_merge_queue"]>;
    /** The head the factory asked GitHub to update from (null: it never asked). */
    requestedFrom: string | null;
    at: string;
    prHead: string;
  },
) {
  const { w, project, repository, repo, entry, at, prHead } = args;
  const github = ctx.services.github;
  const info = await github.commitInfo(repo, prHead).catch(() => null);
  const merged = info?.parents[1];
  const requestedByFactory = args.requestedFrom === at;
  const madeByGitHub =
    info?.verified === true &&
    info.committer?.email === "noreply@github.com" &&
    info.parents.length === 2 &&
    info.parents[0] === at &&
    merged !== undefined &&
    (await github.compareCommits(repo, repository.default_branch, merged)).aheadBy === 0;
  const babysitter = entry.driver === "babysitter";
  if (!babysitter && !(requestedByFactory && madeByGitHub)) {
    return {
      state: "moved" as const,
      headSha: prHead,
      reason: `the branch moved to ${prHead.slice(0, 7)}, which isn't the queue's merge of ${repository.default_branch} into ${at.slice(0, 7)}`,
    };
  }
  let thirdThings: string[] | null = null;
  let digestNow: string | null = null;
  if (babysitter && requestedByFactory && madeByGitHub && merged) {
    // Only the paths the merge changed on the approved head are read, never whole trees (second
    // review of #105): a path the merge left alone is the approved head's by definition.
    try {
      const changed = await github.changedPaths(repo, at, prHead);
      if (changed.complete && changed.paths.length <= MAX_CHANGED_PATHS) {
        const [a, m, h] = await Promise.all([
          github.pathEntries(repo, at, changed.paths),
          github.pathEntries(repo, merged, changed.paths),
          github.pathEntries(repo, prHead, changed.paths),
        ]);
        thirdThings = onlyEitherSide(a, m, h);
      }
    } catch {
      thirdThings = null; // unreadable: fails closed
    }
    digestNow = await digestOf(ctx, prHead, repository, repo);
  }
  const survives =
    !babysitter ||
    approvalSurvivesMergeOfMain({
      requestedByFactory,
      madeByGitHub,
      thirdThings,
      approvedDigest: entry.approved_digest,
      digestNow,
    });
  ctx.write(
    ctx.db
      .updateTable("core_merge_queue")
      .set({ head_sha: prHead, updated_at: ctx.now })
      .where("id", "=", entry.id)
      .where("head_sha", "=", at),
  );
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({ head_sha: prHead, updated_at: ctx.now })
      .where("id", "=", w.id),
  );
  ctx.change({
    entity: "work_item",
    id: w.id,
    before: { sha: at },
    after: { sha: prHead, by: `merge queue: ${repository.default_branch} merged in` },
  });
  if (!survives) {
    const why = !requestedByFactory
      ? "the factory didn't ask for this merge"
      : !madeByGitHub
        ? "it isn't GitHub's update-branch merge of the default branch into the approved head"
        : thirdThings === null
          ? "its files couldn't be read in full"
          : thirdThings.length > 0
            ? `it changed files beyond a merge of its two sides (${thirdThings.slice(0, 5).join(", ")}${thirdThings.length > 5 ? ", …" : ""})`
            : entry.approved_digest === null || digestNow === null
              ? "the approved change couldn't be read in full"
              : `the PR's change against ${repository.default_branch} is not the one approved`;
    // The approval no longer holds: closed, so nothing can carry it out (ADR 0582).
    if (entry.pending_action_id) {
      ctx.writePendingStatus(
        "close",
        ctx.db
          .updateTable("core_pending_actions")
          .set({
            status: "rejected",
            decision: "withdrawn",
            decided_at: ctx.now,
            note: `withdrawn: ${why}`,
          })
          .where("id", "=", entry.pending_action_id)
          .where("status", "=", "approved"),
      );
    }
    return {
      state: "withdrawn" as const,
      headSha: prHead,
      reason: `the approval was withdrawn when ${repository.default_branch} was merged in: ${why}`,
    };
  }
  // The change is the one approved, but the evidence is the old head's (second review of #105).
  // Nothing is carried and `factory/verify` is not posted from the old packet: the new head is
  // verified on its own (its checks run again there), and the approval carries over only once
  // that passes (owner's answer to question 1, 2026-11-12). The approval stays approved meanwhile,
  // bound to this change: `mergeQueue.enter` takes it back only for a head whose change digest is
  // still the approved one.
  if (babysitter) {
    return {
      state: "reverify" as const,
      headSha: prHead,
      reason: `${repository.default_branch} was merged in cleanly and the change is the one approved; ${prHead.slice(0, 7)} is verified again before it merges`,
    };
  }
  await carryReviewPacket(ctx, { item: w, project, repo, fromSha: at, toSha: prHead });
  return { state: "updated" as const, headSha: prHead, reason: null };
}

/**
 * The most changed paths a change digest reads (spec 53): past it the approval doesn't carry over.
 * Below GitHub's 300-file compare cap, and a bounded number of GraphQL directory reads.
 */
export const MAX_CHANGED_PATHS = 250;

/**
 * The change digest of `headSha` (its changed paths against its merge base with the default
 * branch), or null when it can't be read in full (an error, too many paths): never a partial digest.
 */
async function digestOf(
  ctx: HandlerContext,
  headSha: string,
  repository: RepositoryRow = requireRepository(ctx),
  repo?: RepoRef,
): Promise<string | null> {
  try {
    const ref = repo ?? (await repoRef(ctx, repository));
    const github = ctx.services.github;
    // The change is the paths GitHub's compare lists against the merge base: only those are read
    // (second review of #105). Past MAX_CHANGED_PATHS, or a compare GitHub can't give in full, there
    // is no digest, and no digest never matches.
    const changed = await github.changedPaths(ref, repository.default_branch, headSha);
    if (!changed.mergeBase || !changed.complete || changed.paths.length > MAX_CHANGED_PATHS) {
      return null;
    }
    const [b, h] = await Promise.all([
      github.pathEntries(ref, changed.mergeBase, changed.paths),
      github.pathEntries(ref, headSha, changed.paths),
    ]);
    return await changeDigest(b, h);
  } catch {
    return null;
  }
}

export const mergeQueueLeave = defineOperation({
  name: "mergeQueue.leave",
  description:
    "Take a work item out of its project's merge queue (ADR 0330): `merged` once it landed, `left` when it goes back to build or stops. Wakes the work item that is head after it. A no-op when it isn't queued.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    outcome: z.enum(["merged", "left"]),
    reason: z.string().max(2_000),
    /** The babysitter's delivery outcome (spec 53), sent to the item's Workflow. */
    delivery: z.enum(["merged", "conflict", "failed", "withdrawn", "reverify"]).optional(),
  }),
  output: z.object({ left: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    return {
      left: await releaseMergeQueue(ctx, w, input.outcome, input.reason, input.delivery),
    };
  },
});

/**
 * How long the deliverer's "merging" mark holds (spec 53 review): longer than a pass's lease, so a
 * pass that died between the mark and GitHub's answer frees the item for a cancel soon after.
 */
export const MERGING_HOLDS_MS = 2 * 60_000;

/**
 * A cancel is refused while the babysitter is merging the item (spec 53 review): between the mark
 * and GitHub's answer the merge may already have happened. Read now and guarded in the cancel's
 * batch, so a mark that commits first refuses the cancel, and a cancel that commits first refuses
 * the mark (`mergeQueue.merging` guards that the item is open).
 */
export async function refuseWhileMerging(ctx: HandlerContext, w: WorkItemRow): Promise<void> {
  const since = new Date(Date.parse(ctx.now) - MERGING_HOLDS_MS).toISOString();
  const entry = await openEntry(ctx, w.id);
  if (entry?.merging_at && entry.merging_at > since) {
    throw new OperationError(
      "conflict",
      `#${w.number} is merging; it cannot be cancelled now. Look again in a minute: once it has merged it is done.`,
    );
  }
  ctx.guardExists(
    "not merging",
    ctx.db
      .selectFrom("core_work_items")
      .select("id")
      .where("id", "=", w.id)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("core_merge_queue")
              .select("id")
              .where("work_item_id", "=", w.id)
              .where("status", "=", "queued")
              .where("merging_at", ">", since),
          ),
        ),
      ),
  );
}

const requireBabysitterEntry = async (ctx: HandlerContext, w: WorkItemRow) => {
  if (ctx.actor.type !== BABYSITTER.type || ctx.actor.id !== BABYSITTER.id) {
    throw new OperationError("forbidden", "only the babysitter's deliverer does this");
  }
  const entry = await openEntry(ctx, w.id);
  if (entry?.driver !== "babysitter") {
    throw new OperationError("conflict", `work item #${w.number} is not in the babysitter's queue`);
  }
  return entry;
};

export const mergeQueueMerging = defineOperation({
  name: "mergeQueue.merging",
  description:
    "The babysitter's deliverer marks the head of its queue as merging just before it asks GitHub to merge (`merging: true`), and releases the mark when GitHub refuses (`merging: false`) (spec 53 review). While the mark holds, a cancel of the item is refused: the merge may already have happened. Marking is refused for an item that is no longer open or an entry no longer queued. The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, merging: z.boolean() }),
  output: z.object({ merging: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const entry = await requireBabysitterEntry(ctx, w);
    if (input.merging) await requireOpenToMerge(ctx, w);
    ctx.write(
      ctx.db
        .updateTable("core_merge_queue")
        .set({ merging_at: input.merging ? ctx.now : null, updated_at: ctx.now })
        .where("id", "=", entry.id),
    );
    ctx.change({ entity: "merge_queue", id: entry.id, after: { merging: input.merging } });
    return { merging: input.merging };
  },
});

/** The answers to the question asked at the update bound (spec 53 review). */
export const HOLD_ANSWERS = {
  now: "Update once more, and merge when CI passes",
  wait: "Wait an hour, then update once more",
} as const;
export const HOLD_WAIT_MS = 60 * 60_000;

/** The open entry holding on this question, for waking its deliverer when it is answered. */
export async function holdingEntry(ctx: HandlerContext, workItemId: string, questionId: string) {
  return (
    (await ctx.db
      .selectFrom("core_merge_queue as q")
      .innerJoin("core_work_items as w", "w.id", "q.work_item_id")
      .select(["w.project_id", "w.repository_id"])
      .where("q.work_item_id", "=", workItemId)
      .where("q.status", "=", "queued")
      .where("q.hold_question_id", "=", questionId)
      .executeTakeFirst()) ?? null
  );
}

export const mergeQueueHold = defineOperation({
  name: "mergeQueue.hold",
  description:
    "At its bound on updates (the default branch kept moving while CI ran) the babysitter holds the head of its queue and asks a person, instead of sending good, approved work back to build (spec 53 review). The first call asks (`asked`); while the question is open, `waiting`; once answered, the person's answer allows one more update, now (`resumed`) or after an hour (`holding`, with `until`). The babysitter only.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, reason: z.string().max(2_000) }),
  output: z.object({
    state: z.enum(["asked", "waiting", "resumed", "holding"]),
    until: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const entry = await requireBabysitterEntry(ctx, w);
    if (entry.held_until && entry.held_until > ctx.now) {
      return { state: "holding" as const, until: entry.held_until };
    }
    const queued = ctx.db
      .selectFrom("core_merge_queue")
      .select("id")
      .where("id", "=", entry.id)
      .where("status", "=", "queued");
    if (!entry.hold_question_id) {
      const questionId = await askOne(ctx, w, {
        prompt: `The default branch keeps moving: #${w.number} was updated ${entry.updates} times and the branch moved again while CI ran. Update once more and merge when CI passes on the new head, or wait?`,
        context: input.reason,
        options: [HOLD_ANSWERS.now, HOLD_ANSWERS.wait],
        defaultAnswer: HOLD_ANSWERS.now,
        recommendationReason:
          "The change is approved and was green; another update only merges the default branch in again.",
      });
      ctx.write(
        ctx.db
          .updateTable("core_merge_queue")
          .set({ hold_question_id: questionId, updated_at: ctx.now })
          .where("id", "=", entry.id),
      );
      ctx.guardExists("entry open", queued);
      ctx.change({ entity: "merge_queue", id: entry.id, after: { held: input.reason } });
      return { state: "asked" as const, until: null };
    }
    const q = await ctx.db
      .selectFrom("core_questions")
      .select(["status", "answer"])
      .where("id", "=", entry.hold_question_id)
      .executeTakeFirst();
    if (q?.status === "open") return { state: "waiting" as const, until: null };
    // Answered (or gone: asked again on the next pass). One more update, now or after an hour.
    const answered = q?.status === "answered";
    const wait = answered && q?.answer === HOLD_ANSWERS.wait;
    const until = wait ? new Date(Date.parse(ctx.now) + HOLD_WAIT_MS).toISOString() : null;
    ctx.write(
      ctx.db
        .updateTable("core_merge_queue")
        .set((eb) => ({
          hold_question_id: null,
          updates_granted: answered ? eb("updates_granted", "+", 1) : eb.ref("updates_granted"),
          held_until: until,
          updated_at: ctx.now,
        }))
        .where("id", "=", entry.id)
        .where("hold_question_id", "=", entry.hold_question_id),
    );
    ctx.guardChanged("hold read once");
    if (!answered) return { state: "waiting" as const, until: null };
    ctx.change({ entity: "merge_queue", id: entry.id, after: { resumed: q?.answer ?? null } });
    return wait ? { state: "holding" as const, until } : { state: "resumed" as const, until: null };
  },
});
