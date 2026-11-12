// Gates (ADR 0007, 0041): the foreman asks (spec.accept, pr.merge, or any operation the gate check
// sends to review); people decide (spec.approve / spec.requestChanges, review.merge /
// review.sendBack, approval.decide). A decision updates the pending action and sends
// `approval-<id>` to the Workflow in the same batch; the Workflow then re-runs the operation with
// the approval, or loops back.
import type { GateDecisionKind } from "@software-factory/db";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext, type PendingActionRow } from "../operation.ts";
import { backupOwnerId } from "../scope.ts";
import { approvalEvent, type GateEventPayload } from "../workflow-events.ts";
import { applyApprovedConfig, CONFIG_WRITES } from "./config.ts";
import { openIncident } from "./incidents.ts";
import { pendingActionId, workItemId } from "./shared.ts";

const decisionOutput = z.object({
  pendingActionId: z.string(),
  decision: z.enum(["approved", "rejected", "changes_requested", "sent_back"]),
  /** True when this exact decision had already been made (a second tap): nothing changed. */
  alreadyDecided: z.boolean(),
});

/**
 * Decides a pending action once. A repeat of the same decision is a no-op that reports
 * `alreadyDecided`; a contradicting one is a conflict (spec 12, criterion 3).
 */
export function decidePending(
  ctx: HandlerContext,
  pa: PendingActionRow,
  decision: GateDecisionKind,
  note: string | null,
  openedFullDiff: boolean | null = null,
): z.input<typeof decisionOutput> {
  if (pa.status !== "pending") {
    const same = pa.decision === decision || (decision === "approved" && pa.status === "applied");
    if (same) return { pendingActionId: pa.id, decision, alreadyDecided: true };
    throw new OperationError("conflict", `already decided: ${pa.decision ?? pa.status}`);
  }
  const gateOpenMs = Date.parse(ctx.now) - Date.parse(pa.created_at);
  ctx.write(
    ctx.db
      .updateTable("core_pending_actions")
      .set({
        status: decision === "approved" ? "approved" : "rejected",
        decision,
        decided_at: ctx.now,
        decided_by: ctx.actor.id,
        note,
        opened_full_diff: openedFullDiff === null ? null : openedFullDiff ? 1 : 0,
        gate_open_ms: gateOpenMs,
      })
      .where("id", "=", pa.id)
      .where("status", "=", "pending"),
  );
  ctx.guardChanged("decide once");
  if (pa.work_item_id) {
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({ status: "running", updated_at: ctx.now })
        .where("id", "=", pa.work_item_id)
        .where("status", "=", "waiting"),
    );
  }
  if (pa.workflow_id) {
    const payload: GateEventPayload = { decision, note, by: ctx.actor.id };
    ctx.emit({
      kind: "workflow.event",
      payload: { instanceId: pa.workflow_id, type: approvalEvent(pa.id), payload: { ...payload } },
    });
  }
  ctx.change({
    entity: "pending_action",
    id: pa.id,
    before: { status: "pending" },
    after: { decision, by: ctx.actor.id, gateOpenMs, openedFullDiff },
  });
  return { pendingActionId: pa.id, decision, alreadyDecided: false };
}

/** The work item's newest pending action of a kind (open first). */
async function gateFor(
  ctx: HandlerContext,
  item: string,
  kind: "spec" | "merge",
): Promise<PendingActionRow> {
  const rows = await ctx.db
    .selectFrom("core_pending_actions")
    .selectAll()
    .where("work_item_id", "=", item)
    .where("kind", "=", kind)
    .orderBy("created_at", "desc")
    .limit(5)
    .execute();
  const pa = rows.find((r) => r.status === "pending") ?? rows[0];
  if (!pa) throw new OperationError("not_found", `no ${kind} gate on this work item`);
  return pa;
}

export const approvalDecide = defineOperation({
  name: "approval.decide",
  description:
    "Approve or reject any pending action by id (the generic gate card). Spec and merge gates have their own operations (spec.approve, review.merge, …) with richer outcomes. Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  input: z.object({
    pendingActionId,
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(4_000).optional(),
  }),
  output: decisionOutput,
  async handler(input, ctx) {
    const pa = await ctx.db
      .selectFrom("core_pending_actions")
      .selectAll()
      .where("id", "=", input.pendingActionId)
      .executeTakeFirst();
    if (!pa) throw new OperationError("not_found", "no such pending action");
    if (pa.kind === "merge" && input.decision === "approved") {
      // Merge is decided on the review packet (ADR 0041), which records whether the diff was opened.
      throw new OperationError("forbidden", "approve a merge with review.merge");
    }
    const decided = decidePending(ctx, pa, input.decision, input.note ?? null);
    // A project-level config proposal has no Workflow to re-run it: apply it here (ADR 0370).
    if (
      input.decision === "approved" &&
      !decided.alreadyDecided &&
      (CONFIG_WRITES as readonly string[]).includes(pa.operation)
    ) {
      await applyApprovedConfig(ctx, pa);
    }
    return decided;
  },
});

export const specApprove = defineOperation({
  name: "spec.approve",
  description:
    "Approve a work item's spec at the spec gate. The Workflow then commits the spec to the work item's branch under docs/specs/ and starts the build. Approvers only; a second approval reports alreadyDecided.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  input: z.object({ workItemId, note: z.string().max(4_000).optional() }),
  output: decisionOutput,
  async handler(input, ctx) {
    return decidePending(
      ctx,
      await gateFor(ctx, input.workItemId, "spec"),
      "approved",
      input.note ?? null,
    );
  },
});

export const specRequestChanges = defineOperation({
  name: "spec.requestChanges",
  description:
    "Send a work item's spec back to planning with a note. The Workflow revises the spec (it can loop any number of times) and asks again. Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  input: z.object({ workItemId, note: z.string().min(1).max(8_000) }),
  output: decisionOutput,
  async handler(input, ctx) {
    return decidePending(
      ctx,
      await gateFor(ctx, input.workItemId, "spec"),
      "changes_requested",
      input.note,
    );
  },
});

export const reviewMerge = defineOperation({
  name: "review.merge",
  description:
    "Merge a work item from its review packet (the merge gate, ADR 0041). The factory merges through the GitHub App. Records whether the full diff was opened first. Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  input: z.object({
    workItemId,
    openedFullDiff: z.boolean(),
    note: z.string().max(4_000).optional(),
  }),
  output: decisionOutput,
  async handler(input, ctx) {
    return decidePending(
      ctx,
      await gateFor(ctx, input.workItemId, "merge"),
      "approved",
      input.note ?? null,
      input.openedFullDiff,
    );
  },
});

export const reviewSendBack = defineOperation({
  name: "review.sendBack",
  description:
    "Send a work item back to build from its review packet, with a note (required). Opens a factory incident proposing a `.factory/` fix (V1 improvement loop). Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  input: z.object({ workItemId, note: z.string().min(1).max(8_000), openedFullDiff: z.boolean() }),
  output: decisionOutput.extend({ incidentId: z.string().nullable() }),
  async handler(input, ctx) {
    const pa = await gateFor(ctx, input.workItemId, "merge");
    const result = decidePending(ctx, pa, "sent_back", input.note, input.openedFullDiff);
    if (result.alreadyDecided) return { ...result, incidentId: null };
    const incident = await openIncident(ctx, {
      kind: "sent_back",
      reason: input.note,
      runId: null,
    });
    return { ...result, incidentId: incident?.incidentId ?? null };
  },
});

export const gateEscalate = defineOperation({
  name: "gate.escalate",
  description:
    "A gate timed out: reassign it to the backup owner and notify them. It stays open: a gate never auto-approves (ADR 0007).",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ pendingActionId }),
  output: z.object({ escalated: z.boolean(), to: z.string().nullable() }),
  async handler(input, ctx) {
    const pa = await ctx.db
      .selectFrom("core_pending_actions")
      .selectAll()
      .where("id", "=", input.pendingActionId)
      .executeTakeFirst();
    if (pa?.status !== "pending" || !pa.org_id) return { escalated: false, to: null };
    const to = await backupOwnerId(ctx.db, pa.org_id, ctx.scope.policy);
    const hours = ctx.scope.policy?.timeouts.gateHours ?? 72;
    ctx.write(
      ctx.db
        .updateTable("core_pending_actions")
        .set((eb) => ({
          assignee_user_id: to,
          escalations: eb("escalations", "+", 1),
          timeout_at: new Date(Date.parse(ctx.now) + hours * 3_600_000).toISOString(),
        }))
        .where("id", "=", pa.id)
        .where("status", "=", "pending"),
    );
    ctx.emit({
      kind: "notify",
      payload: {
        event: "gate.escalated",
        userId: to,
        workItemId: pa.work_item_id,
        title: `A gate is waiting too long: ${pa.operation}`,
        url: pa.work_item_id ? `/?item=${pa.work_item_id}` : "/",
      },
    });
    ctx.change({
      entity: "pending_action",
      id: pa.id,
      before: { assignee: pa.assignee_user_id },
      after: { assignee: to },
    });
    return { escalated: true, to };
  },
});
