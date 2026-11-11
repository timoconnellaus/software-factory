// The spike's operations. Each is the only way to make its change; the Workflow and the inbox call
// them through `invoke()`.
import { z } from "zod";
import { defineOperation } from "./define";
import { OperationError } from "./errors";
import { PRESETS } from "./gate";

const workItemId = z.string().regex(/^wi-[0-9a-f]{32}$/);
const STATUSES = ["running", "done", "rejected", "stopped", "expired", "failed"] as const;

/**
 * Workflow (and work item) id derived from the intake event, so a redelivered event maps to the
 * same instance. ≤ 100 chars of [a-zA-Z0-9_-], as Workflows require.
 */
export async function workItemIdFor(source: string, externalId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${source}\u0000${externalId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `wi-${hex.slice(0, 32)}`;
}

export const intake = defineOperation({
  name: "workItem.intake",
  description:
    "Create a work item from an intake event and start its Workflow. Idempotent per (source, externalId).",
  risk: "write",
  actors: ["intake", "human"],
  input: z.object({
    source: z.string().min(1).max(40),
    externalId: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    body: z.string().max(20_000).default(""),
    size: z.enum(["small", "large"]).optional(),
  }),
  output: z.object({ workItemId, duplicate: z.boolean() }),
  async handler(input, ctx) {
    const id = await workItemIdFor(input.source, input.externalId);
    ctx.subject(id);
    const existing = await ctx.db
      .prepare(`SELECT id FROM work_items WHERE id = ?`)
      .bind(id)
      .first();
    if (existing) return { workItemId: id, duplicate: true };
    ctx.write(
      ctx.db
        .prepare(
          `INSERT INTO work_items (id, source, external_id, title, body, size, stage, status, workflow_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'intake', 'running', ?, ?, ?)`,
        )
        .bind(
          id,
          input.source,
          input.externalId,
          input.title,
          input.body,
          input.size ?? null,
          id,
          ctx.now,
          ctx.now,
        ),
    );
    ctx.emit({ kind: "workflow.create", payload: { id, params: { workItemId: id } } });
    return { workItemId: id, duplicate: false };
  },
});

export const triage = defineOperation({
  name: "workItem.triage",
  description: "Record triage: the work item's size decides whether it needs a spec gate.",
  risk: "write",
  actors: ["agent"],
  input: z.object({ workItemId, size: z.enum(["small", "large"]), route: z.string().max(200) }),
  output: z.object({ size: z.enum(["small", "large"]) }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(`UPDATE work_items SET size = ?, stage = 'triage', updated_at = ? WHERE id = ?`)
        .bind(input.size, ctx.now, input.workItemId),
    );
    return { size: input.size };
  },
});

export const specAccept = defineOperation({
  name: "spec.accept",
  description: "Accept the proposed spec so the build can start. Risk `plan`: the spec gate.",
  risk: "plan",
  actors: ["agent"],
  input: z.object({ workItemId, spec: z.string().min(1).max(20_000) }),
  output: z.object({ accepted: z.literal(true) }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(`UPDATE work_items SET stage = 'spec', updated_at = ? WHERE id = ?`)
        .bind(ctx.now, input.workItemId),
    );
    return { accepted: true as const };
  },
});

export const buildRecord = defineOperation({
  name: "build.record",
  description:
    "Record a runner job's result (branch, commit). Stub for the runner contract's hand-back.",
  risk: "write",
  actors: ["runner"],
  input: z.object({ workItemId, branch: z.string(), commit: z.string() }),
  output: z.object({ branch: z.string(), commit: z.string() }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(`UPDATE work_items SET stage = 'build', updated_at = ? WHERE id = ?`)
        .bind(ctx.now, input.workItemId),
    );
    return { branch: input.branch, commit: input.commit };
  },
});

export const verifyRecord = defineOperation({
  name: "verify.record",
  description: "Record the review packet's verdict. Stub: checks only.",
  risk: "write",
  actors: ["agent"],
  input: z.object({ workItemId, checks: z.record(z.string(), z.enum(["pass", "fail"])) }),
  output: z.object({ passed: z.boolean() }),
  async handler(input, ctx) {
    const passed = Object.values(input.checks).every((c) => c === "pass");
    ctx.write(
      ctx.db
        .prepare(`UPDATE work_items SET stage = 'verify', updated_at = ? WHERE id = ?`)
        .bind(ctx.now, input.workItemId),
    );
    return { passed };
  },
});

export const prMerge = defineOperation({
  name: "pr.merge",
  description: "Merge the work item's PR. Risk `merge`: always reviewed for non-human actors.",
  risk: "merge",
  actors: ["agent", "human"],
  input: z.object({ workItemId, branch: z.string() }),
  output: z.object({ merged: z.literal(true) }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(
          `UPDATE work_items SET stage = 'merged', status = 'done', updated_at = ? WHERE id = ?`,
        )
        .bind(ctx.now, input.workItemId),
    );
    return { merged: true as const };
  },
});

export const close = defineOperation({
  name: "workItem.close",
  description: "End a work item without merging (rejected at a gate, expired, refused, stopped).",
  risk: "write",
  actors: ["agent", "human"],
  input: z.object({
    workItemId,
    status: z.enum(STATUSES).exclude(["running", "done"]),
    reason: z.string().max(500),
  }),
  output: z.object({ status: z.string() }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(
          `UPDATE work_items SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
        )
        .bind(input.status, ctx.now, input.workItemId),
    );
    return { status: input.status };
  },
});

export const approvalDecide = defineOperation({
  name: "approval.decide",
  description:
    "Approve or reject a pending action. Sends `approval-<id>` to the work item's Workflow (via the outbox).",
  risk: "write",
  actors: ["human"],
  input: z.object({
    pendingActionId: z.string().regex(/^pa_[0-9a-f]{32}$/),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(2000).optional(),
  }),
  output: z.object({ pendingActionId: z.string(), decision: z.string(), duplicate: z.boolean() }),
  async handler(input, ctx) {
    const action = await ctx.db
      .prepare(`SELECT status, work_item_id, workflow_id FROM pending_actions WHERE id = ?`)
      .bind(input.pendingActionId)
      .first<{ status: string; work_item_id: string | null; workflow_id: string | null }>();
    if (!action) throw new OperationError("not_found", "no such pending action");
    if (action.work_item_id) ctx.subject(action.work_item_id);
    // A second tap on the same decision is a no-op; a contradicting one is a conflict.
    if (action.status !== "pending") {
      if (
        action.status === input.decision ||
        (action.status === "applied" && input.decision === "approved")
      ) {
        return {
          pendingActionId: input.pendingActionId,
          decision: input.decision,
          duplicate: true,
        };
      }
      throw new OperationError("conflict", `already ${action.status}`);
    }
    ctx.write(
      ctx.db
        .prepare(
          `UPDATE pending_actions SET status = ?, decided_at = ?, decided_by = ?, note = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(input.decision, ctx.now, ctx.actor.id, input.note ?? null, input.pendingActionId),
    );
    if (action.workflow_id) {
      ctx.emit({
        kind: "workflow.event",
        payload: {
          instanceId: action.workflow_id,
          type: `approval-${input.pendingActionId}`,
          payload: { decision: input.decision, by: ctx.actor.id },
        },
      });
    }
    return { pendingActionId: input.pendingActionId, decision: input.decision, duplicate: false };
  },
});

export const setKillSwitch = defineOperation({
  name: "factory.setKillSwitch",
  description:
    "Turn the kill switch on or off. On: every non-human write is refused, running work items stop and their Workflows are terminated.",
  risk: "self-modify",
  actors: ["human"],
  input: z.object({ on: z.boolean() }),
  output: z.object({ on: z.boolean(), stopped: z.number() }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('kill_switch', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .bind(input.on ? "on" : "off"),
    );
    if (!input.on) return { on: false, stopped: 0 };
    const { results } = await ctx.db
      .prepare(`SELECT id, workflow_id FROM work_items WHERE status = 'running'`)
      .all<{ id: string; workflow_id: string }>();
    ctx.write(
      ctx.db
        .prepare(
          `UPDATE work_items SET status = 'stopped', updated_at = ? WHERE status = 'running'`,
        )
        .bind(ctx.now),
    );
    for (const row of results) {
      ctx.emit({ kind: "workflow.terminate", payload: { instanceId: row.workflow_id } });
    }
    return { on: true, stopped: results.length };
  },
});

export const setPreset = defineOperation({
  name: "policy.setPreset",
  description: "Choose the autonomy preset. The floor (env APPROVAL_FLOOR) still applies on top.",
  risk: "self-modify",
  actors: ["human"],
  input: z.object({ preset: z.enum(PRESETS) }),
  output: z.object({ preset: z.enum(PRESETS) }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(
          `INSERT INTO settings (key, value) VALUES ('preset', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .bind(input.preset),
    );
    return { preset: input.preset };
  },
});
