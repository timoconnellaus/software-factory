// A person's push to the branch of a factory-built work item (ADR 0587). The factory's own pushes
// (a run's branch, the control plane's moves, the babysitter's update-branch) come from its App and
// are push.observe's confinement checks; a push by anyone else to a factory item's branch, from
// verify on, means the head the factory verified (or is verifying) is no longer the PR's.

import type { HandlerContext, WorkItemRow } from "../operation.ts";
import { approvalEvent, ciEvent, type GateEventPayload, runEvent } from "../workflow-events.ts";
import { has } from "../workflow-features.ts";
import { MERGING_HOLDS_MS, openEntry, releaseMergeQueue } from "./merge-queue.ts";
import { ACTIVE_RUN } from "./runners.ts";

/** What push.observe reports for a person's push to a factory item's branch. */
export interface PushedHead {
  /** `reverify`: the item goes back to verify the new head. `told`: recorded, nothing withdrawn. */
  outcome: "reverify" | "told" | "ignored";
  detail: string;
}

/**
 * Records a person's push of `headSha` to `item`'s branch (the caller checked the branch's head on
 * GitHub is `headSha`, so a late delivery for an older push can't move the item back).
 *
 * - Workflow v14 ("reverify-on-push"): the item's head becomes `headSha`. An open merge gate is
 *   withdrawn (its Inbox card goes); an approval the babysitter holds is closed and its delivery
 *   ends `withdrawn`; either way the Workflow verifies the new head without a build. In verify,
 *   the run finishing on the old head opens no gate (the Workflow reads the head after it), and a
 *   CI wait on the old head is woken. Several pushes coalesce: only the newest head is verified.
 * - Earlier versions: an open merge gate (or the babysitter's approval) is withdrawn the same way,
 *   and the Workflow verifies the new head (v12) or, for a delivery before v12, treats it as a
 *   failed delivery. With nothing open to withdraw (verify running), the item keeps the head it
 *   is verifying, as its version always did, and the push is recorded on its activity: the gate
 *   that opens is for the old head, and Send back verifies the new one.
 * - The babysitter merging it right now: left to the babysitter, whose merge GitHub refuses for a
 *   moved head and which then withdraws the approval itself (spec 53).
 */
export async function personPushed(
  ctx: HandlerContext,
  item: WorkItemRow,
  headSha: string,
  pusher: string,
): Promise<PushedHead> {
  const short = headSha.slice(0, 7);
  const was = item.head_sha?.slice(0, 7) ?? "none";
  const reverifies = has(item.workflow_version, "reverify-on-push");
  const entry = await openEntry(ctx, item.id);
  const since = new Date(Date.parse(ctx.now) - MERGING_HOLDS_MS).toISOString();
  if (entry?.merging_at && entry.merging_at > since) {
    return {
      outcome: "ignored",
      detail: `${pusher} pushed ${short} while the babysitter was merging ${was}: the babysitter decides`,
    };
  }
  const gates = await ctx.db
    .selectFrom("core_pending_actions")
    .select(["id", "workflow_id"])
    // core_pending_actions_item_idx (work_item_id, status): an item's few gates.
    .where("work_item_id", "=", item.id)
    .where("status", "=", "pending")
    .where("kind", "=", "merge")
    .execute();
  const delivering = entry?.driver === "babysitter" && entry.pending_action_id !== null;
  if (!reverifies && gates.length === 0 && !delivering) {
    ctx.change({
      entity: "work_item",
      id: item.id,
      after: { pushedBy: pusher, pushed: headSha, verifying: item.head_sha },
    });
    return {
      outcome: "told",
      detail: `${pusher} pushed ${short} while the factory verifies ${was}: send it back to verify ${short}`,
    };
  }

  const note = `a new commit was pushed by ${pusher}`;
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set((eb) => ({
        head_sha: headSha,
        status: eb
          .case()
          .when("status", "=", "waiting")
          .then("running" as const)
          .else(eb.ref("status"))
          .end(),
        status_reason: eb
          .case()
          .when("status", "=", "waiting")
          .then(null)
          .else(eb.ref("status_reason"))
          .end(),
        updated_at: ctx.now,
      }))
      .where("id", "=", item.id),
  );
  if (gates.length > 0) {
    ctx.writePendingStatus(
      "close",
      ctx.db
        .updateTable("core_pending_actions")
        .set({
          status: "rejected",
          decision: "withdrawn",
          decided_at: ctx.now,
          decided_by: ctx.actor.id,
          note,
        })
        .where("work_item_id", "=", item.id)
        .where("kind", "=", "merge")
        .where("status", "=", "pending"),
    );
    for (const gate of gates) {
      if (!gate.workflow_id) continue;
      const payload: GateEventPayload = { decision: "withdrawn", note, by: ctx.actor.id };
      ctx.emit({
        kind: "workflow.event",
        payload: {
          instanceId: gate.workflow_id,
          type: approvalEvent(gate.id),
          payload: { ...payload },
        },
      });
    }
  }
  if (delivering && entry?.pending_action_id) {
    // The approval was for the old head: closed, so nothing can carry it out, and the delivery
    // ends `withdrawn` (v12+: the Workflow verifies the new head, then a person decides again).
    ctx.writePendingStatus(
      "close",
      ctx.db
        .updateTable("core_pending_actions")
        .set({
          status: "rejected",
          decision: "withdrawn",
          decided_at: ctx.now,
          note: `withdrawn: ${note}`,
        })
        .where("id", "=", entry.pending_action_id)
        .where("status", "=", "approved"),
    );
    await releaseMergeQueue(ctx, item, "left", `withdrawn: ${note}`, "withdrawn");
  }
  if (reverifies && gates.length === 0 && !delivering) await cancelStaleVerify(ctx, item, note);
  if (reverifies && item.head_sha && gates.length === 0 && !delivering) {
    // In verify: a CI wait on the old head wakes and sees it is stale.
    ctx.emit({
      kind: "workflow.event",
      payload: {
        instanceId: item.workflow_id,
        type: ciEvent(item.id, item.head_sha),
        payload: { state: "stale" },
      },
    });
  }
  ctx.change({
    entity: "work_item",
    id: item.id,
    before: { headSha: item.head_sha },
    after: { headSha, reason: note },
  });
  return { outcome: "reverify", detail: `${pusher} pushed ${short}: verifying again` };
}

/**
 * v14: a verify run still working on the old head is cancelled through the item's lease (ADR 0587):
 * the fencing token goes up, so the runner's next heartbeat gets a `cancel` for the job and every
 * write the run still makes is refused. The Workflow reads the head first when the run ends, so it
 * verifies the new head, counting no failure. Only a verify run: a build in flight is left alone
 * (`branch.advance` refuses its non-fast-forward, as before).
 */
async function cancelStaleVerify(ctx: HandlerContext, item: WorkItemRow, note: string) {
  // Point lookups: core_leases by its key (work_item_id), core_runs by its key (id).
  const lease = await ctx.db
    .selectFrom("core_leases")
    .select(["holder_kind", "holder_id", "fencing_token"])
    .where("work_item_id", "=", item.id)
    .executeTakeFirst();
  if (lease?.holder_kind !== "run" || !lease.holder_id) return;
  const run = await ctx.db
    .selectFrom("core_runs")
    .select(["id", "job_id", "status", "stage"])
    .where("id", "=", lease.holder_id)
    .executeTakeFirst();
  if (run?.stage !== "verify") return;
  if (!(ACTIVE_RUN as readonly string[]).includes(run.status)) return;
  ctx.write(
    ctx.db
      .updateTable("core_leases")
      .set((eb) => ({
        fencing_token: eb("fencing_token", "+", 1),
        holder_kind: null,
        holder_id: null,
        released_at: ctx.now,
      }))
      .where("work_item_id", "=", item.id)
      .where("fencing_token", "=", lease.fencing_token),
  );
  ctx.write(
    ctx.db
      .updateTable("core_runs")
      .set({ status: "cancelled", outcome: "cancelled", ended_at: ctx.now })
      .where("id", "=", run.id)
      .where("status", "in", [...ACTIVE_RUN]),
  );
  ctx.write(
    ctx.db
      .updateTable("core_jobs")
      .set({ status: "cancelled", finished_at: ctx.now })
      .where("id", "=", run.job_id),
  );
  ctx.emit({
    kind: "workflow.event",
    payload: {
      instanceId: item.workflow_id,
      type: runEvent(run.job_id),
      payload: { runId: run.id, outcome: "cancelled", reason: `superseded: ${note}` },
    },
  });
}
