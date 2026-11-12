// The merge queue (ADR 0330, spec 06): approved merges land one at a time per project, so each PR
// runs CI once, against the default branch it will land on. A work item enters after its merge is
// approved (or for a check-only incident fix, before auto-merge is tried). Only the head of the
// queue is brought up to date (GitHub's update-branch: a clean merge of the default branch into the
// approved head) and merged; nothing else lands while its CI runs. A conflict, or red CI after the
// update, takes the item out of the queue and back to build. pr.merge and pr.autoMerge refuse a
// queued item that isn't the head, or a head the queue didn't bring there.
import type { DeliveryOutcome, MergeQueueDriver, MergeQueueStatus } from "@software-factory/db";
import { z } from "zod";
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
import { deliveredEvent, mergeQueueEvent } from "../workflow-events.ts";
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
      // A repair of a red default branch goes first (spec 53, ADR 0581): it is what may land.
      .orderBy("w.repairs_main", "desc")
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
async function openEntry(ctx: HandlerContext, item: string) {
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
        payload: { outcome: told, reason },
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
  outcome: z.enum(["merged", "conflict", "failed", "withdrawn"]).nullable(),
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
      .select(["id", "outcome", "end_reason"])
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
      headSha: null,
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
    if (!w.pr_number) throw new OperationError("conflict", "no pull request");
    if (w.head_sha !== input.headSha) {
      throw new OperationError("conflict", "the branch moved since the review packet was made");
    }
    const existing = await openEntry(ctx, w.id);
    if (!existing) {
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
    "Bring the head of the merge queue up to date with the default branch (ADR 0330). `current`: it already contains the default branch. `updating`: GitHub was asked to merge the default branch in (update-branch); call again to see the result. `updated`: GitHub made that clean merge; the review packet carries over to the new head and CI runs there. `conflict`: the default branch can't merge in cleanly (back to build). `refused`/`moved`: GitHub refused, or the head moved some other way. Only the head may update. Risk `write`, like the control plane's other moves of a work item's branch.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId }),
  output: z.object({
    state: z.enum(["current", "updating", "updated", "conflict", "refused", "moved"]),
    headSha: z.string(),
    reason: z.string().nullable(),
  }),
  async handler(_input, ctx) {
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
      return acceptUpdate(ctx, { w, project, repository, repo, entryId: entry.id, at, prHead });

    const behind = (await github.compareCommits(repo, repository.default_branch, at)).behindBy;
    if (behind === 0) return { state: "current" as const, headSha: at, reason: null };
    if (pr.mergeable === false) {
      return {
        state: "conflict" as const,
        headSha: at,
        reason: `${repository.default_branch} can't merge into the branch cleanly`,
      };
    }
    const asked = await github.updatePullRequestBranch(repo, {
      number: w.pr_number,
      expectedHeadSha: at,
    });
    if (asked.status === "requested") {
      // When it was asked, so the babysitter knows how long GitHub has been at it (spec 53).
      ctx.write(
        ctx.db
          .updateTable("core_merge_queue")
          .set({ update_asked_at: ctx.now })
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
          entryId: entry.id,
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
 * The head moved after the queue asked GitHub to update it. Accepted only as GitHub's
 * update-branch merge: first parent the head the queue had, second parent a commit already on the
 * default branch. Anything else is a push the queue didn't make.
 */
async function acceptUpdate(
  ctx: HandlerContext,
  args: {
    w: WorkItemRow;
    project: ProjectRow;
    repository: RepositoryRow;
    repo: RepoRef;
    entryId: string;
    at: string;
    prHead: string;
  },
) {
  const { w, project, repository, repo, at, prHead } = args;
  const github = ctx.services.github;
  // The head moved. Accept it only as GitHub's update-branch merge: first parent the head the
  // queue had, second parent a commit already on the default branch. Anything else is a push
  // the queue didn't make.
  const parents = await github.commitParents(repo, prHead);
  const merged = parents[1];
  const clean =
    parents.length === 2 &&
    parents[0] === at &&
    merged !== undefined &&
    (await github.compareCommits(repo, repository.default_branch, merged)).aheadBy === 0;
  if (!clean) {
    return {
      state: "moved" as const,
      headSha: prHead,
      reason: `the branch moved to ${prHead.slice(0, 7)}, which isn't the queue's merge of ${repository.default_branch} into ${at.slice(0, 7)}`,
    };
  }
  ctx.write(
    ctx.db
      .updateTable("core_merge_queue")
      .set({ head_sha: prHead, updated_at: ctx.now })
      .where("id", "=", args.entryId)
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
  await carryReviewPacket(ctx, { item: w, project, repo, fromSha: at, toSha: prHead });
  return { state: "updated" as const, headSha: prHead, reason: null };
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
    delivery: z.enum(["merged", "conflict", "failed"]).optional(),
  }),
  output: z.object({ left: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    return {
      left: await releaseMergeQueue(ctx, w, input.outcome, input.reason, input.delivery),
    };
  },
});
