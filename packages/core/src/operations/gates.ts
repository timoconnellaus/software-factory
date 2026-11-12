// Gates (ADR 0007, 0041): the foreman asks (spec.accept, pr.merge, or any operation the gate check
// sends to review); people decide (spec.approve / spec.requestChanges, review.merge /
// review.sendBack, approval.decide). A decision updates the pending action and sends
// `approval-<id>` to the Workflow in the same batch; the Workflow then re-runs the operation with
// the approval, or loops back.
import type { CoreDatabase, GateDecisionKind } from "@software-factory/db";
import type { ExpressionBuilder } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext, type PendingActionRow } from "../operation.ts";
import { assertSpecGateCurrent } from "../planning.ts";
import { backupOwnerId } from "../scope.ts";
import { approvalEvent, type GateEventPayload } from "../workflow-events.ts";
import { applyApprovedConfig, CONFIG_WRITES } from "./config.ts";
import { openIncident } from "./incidents.ts";
import { pendingActionId, sha, workItemId } from "./shared.ts";
import { applyApprovedOrgConfig, ORG_CONFIG_WRITES } from "./workflows.ts";

/** The commit a merge gate is for: the head SHA in its `pr.merge` input (ADR 0041). */
export function mergeGateHead(pa: PendingActionRow): string | null {
  try {
    const input = JSON.parse(pa.input) as { headSha?: unknown };
    return typeof input.headSha === "string" ? input.headSha : null;
  } catch {
    return null;
  }
}

const decisionOutput = z.object({
  pendingActionId: z.string(),
  decision: z.enum(["approved", "rejected", "changes_requested", "sent_back"]),
  /** True when this exact decision had already been made (a second tap): nothing changed. */
  alreadyDecided: z.boolean(),
});

/**
 * Whether the phone may decide this pending action, by any operation (ADR 0541 amendment,
 * 2026-11-12). Not a config change (`config.save`, `config.rollback`) and nothing self-modify (a
 * merge that touches `.factory/` included): the fingerprint prompt reads only "Approve config.save
 * on #n", and binding it to the version's digest is spec 60 PR 8. Until then these are decided on
 * the desktop app or the website. `decidePending` checks it, so every deciding operation does.
 */
export function phoneMayDecidePending(pa: { operation: string; risk: string }): boolean {
  return !(CONFIG_WRITES as readonly string[]).includes(pa.operation) && pa.risk !== "self-modify";
}

export const PHONE_REFUSES_PENDING =
  "this change is approved on the desktop app or the website, not the phone: approve this on the desktop app or the website";

export const PHONE_REFUSES_CANCEL =
  "this work item waits on a change that is approved on the desktop app or the website, not the phone: cancel it on the desktop app or the website";

/**
 * Cancelling a work item rejects its open pending actions (ADR 0541 amendment, third review). From
 * the phone that would reject a config change or a self-modify action, which the phone may not
 * decide, so the phone can't cancel an item while one is open. Guarded in the batch too, so one
 * opened meanwhile also refuses. Withdrawing a spec gate because a person wrote (a take-back) isn't
 * this: it decides nothing and the gate opens again.
 */
export async function refusePhoneCancel(ctx: HandlerContext, workItemId: string): Promise<void> {
  if (ctx.actor.type !== "human" || ctx.origin.surface !== "mobile") return;
  const undecidable = (eb: ExpressionBuilder<CoreDatabase, "core_pending_actions">) =>
    eb.and([
      eb("work_item_id", "=", workItemId),
      eb("status", "=", "pending"),
      eb.or([eb("operation", "in", [...CONFIG_WRITES]), eb("risk", "=", "self-modify")]),
    ]);
  const open = await ctx.db
    .selectFrom("core_pending_actions")
    .select("id")
    .where(undecidable)
    .limit(1)
    .executeTakeFirst();
  if (open) throw new OperationError("forbidden", PHONE_REFUSES_CANCEL, { decideElsewhere: true });
  ctx.guardExists(
    "no gate the phone may not decide",
    ctx.db
      .selectFrom("core_work_items")
      .select("id")
      .where("id", "=", workItemId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom("core_pending_actions").select("id").where(undecidable))),
      ),
  );
}

/**
 * Decides a pending action once. Every operation that decides one goes through here, so the
 * phone's limit (`phoneMayDecidePending`) holds whichever operation it calls; it may only be called
 * from an operation that declares `decidesPending` (invoke() refuses the write otherwise), and no
 * other write may set a pending action's status but a `close` or an `apply`. A repeat of the same decision is a no-op that reports
 * `alreadyDecided`; a contradicting one is a conflict (spec 12, criterion 3).
 */
export function decidePending(
  ctx: HandlerContext,
  pa: PendingActionRow,
  decision: GateDecisionKind,
  note: string | null,
  openedFullDiff: boolean | null = null,
): z.input<typeof decisionOutput> {
  if (ctx.actor.type === "human" && ctx.origin.surface === "mobile" && !phoneMayDecidePending(pa)) {
    throw new OperationError("forbidden", PHONE_REFUSES_PENDING, { decideElsewhere: true });
  }
  if (pa.status !== "pending") {
    const same = pa.decision === decision || (decision === "approved" && pa.status === "applied");
    if (same) return { pendingActionId: pa.id, decision, alreadyDecided: true };
    throw new OperationError("conflict", `already decided: ${pa.decision ?? pa.status}`);
  }
  const gateOpenMs = Date.parse(ctx.now) - Date.parse(pa.created_at);
  ctx.writePendingStatus(
    "decide",
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
  decidesPending: true,
  description:
    "Approve or reject any pending action by id (the generic gate card). Spec and merge gates have their own operations (spec.approve, review.merge, …) with richer outcomes. Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  // A loosening of a project's org workflow is an org admin's to decide (spec 52, Q6).
  async permissionOf(input, at) {
    const pa = await at.db
      .selectFrom("core_pending_actions")
      .select("decider")
      .where("id", "=", input.pendingActionId)
      .executeTakeFirst();
    return pa?.decider === "org-admin" ? "admin" : "approver";
  },
  browserOnly: true,
  presenceDecidable: true,
  // On the phone, rejecting holds work back and is one tap; approving takes the fingerprint.
  mobileDecidable: (input) => input.decision === "rejected",
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
    if (pa.kind === "spec" && pa.status === "pending" && input.decision === "approved") {
      await assertSpecGateCurrent(ctx, pa.work_item_id);
    }
    // An org config proposal is decided in the app only (ADR 0516): not with a desktop device's
    // presence proof, nor any other surface's token.
    if (
      (ORG_CONFIG_WRITES as readonly string[]).includes(pa.operation) &&
      ctx.origin.surface !== "app" &&
      ctx.origin.surface !== "test"
    ) {
      throw new OperationError(
        "forbidden",
        `an org config change is decided in the app, not from ${ctx.origin.surface}`,
        { browserOnly: true },
      );
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
    // So is an org config proposal (spec 52 PR (b)): an org admin approves it (Q6).
    if (
      input.decision === "approved" &&
      !decided.alreadyDecided &&
      (ORG_CONFIG_WRITES as readonly string[]).includes(pa.operation)
    ) {
      await applyApprovedOrgConfig(ctx, pa);
    }
    return decided;
  },
});

export const specApprove = defineOperation({
  name: "spec.approve",
  decidesPending: true,
  description:
    "Approve a work item's spec at the spec gate. The Workflow then commits the spec to the work item's branch under docs/specs/ and starts the build. Approvers only; a second approval reports alreadyDecided.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  presenceDecidable: true,
  input: z.object({ workItemId, note: z.string().max(4_000).optional() }),
  output: decisionOutput,
  async handler(input, ctx) {
    const pa = await gateFor(ctx, input.workItemId, "spec");
    // A gate the planner no longer stands behind (a person wrote after it asked) can't be approved.
    if (pa.status === "pending") await assertSpecGateCurrent(ctx, pa.work_item_id);
    return decidePending(ctx, pa, "approved", input.note ?? null);
  },
});

export const specRequestChanges = defineOperation({
  name: "spec.requestChanges",
  decidesPending: true,
  description:
    "Send a work item's spec back to planning with a note. The Workflow revises the spec (it can loop any number of times) and asks again. Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  presenceDecidable: true,
  mobileDecidable: true,
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
  decidesPending: true,
  description:
    "Merge a work item from its review packet (the merge gate, ADR 0041). The factory merges through the GitHub App. Records whether the full diff was opened first. With `headSha` (the phone always sends it, spec 60), the approval is for that commit only: a gate whose head has moved refuses it with `conflict`. Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  presenceDecidable: true,
  input: z.object({
    workItemId,
    openedFullDiff: z.boolean(),
    /** The commit the person approves (spec 60): the proof binds to it through the input digest. */
    headSha: sha.optional(),
    note: z.string().max(4_000).optional(),
  }),
  output: decisionOutput,
  async handler(input, ctx) {
    if (ctx.origin.surface === "mobile" && !input.headSha) {
      throw new OperationError(
        "invalid_input",
        "a merge from the phone names its commit (headSha)",
      );
    }
    const pa = await gateFor(ctx, input.workItemId, "merge");
    if (input.headSha && pa.status === "pending" && mergeGateHead(pa) !== input.headSha) {
      throw new OperationError(
        "conflict",
        "A new push withdrew this approval: the merge gate is for another commit now",
        { headSha: mergeGateHead(pa) },
      );
    }
    return decidePending(ctx, pa, "approved", input.note ?? null, input.openedFullDiff);
  },
});

export const reviewSendBack = defineOperation({
  name: "review.sendBack",
  decidesPending: true,
  description:
    "Send a work item back to build from its review packet, with a note (required). Opens a factory incident proposing a `.factory/` fix (V1 improvement loop). Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  presenceDecidable: true,
  mobileDecidable: true,
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
