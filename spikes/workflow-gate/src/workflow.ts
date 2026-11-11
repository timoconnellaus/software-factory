// One Workflow instance per work item: intake → triage → spec gate → build → verify → merge gate.
// The Workflow owns the order of stages and the gates; every change it makes is an operation
// called through `invoke()`, so the gate (not this code) decides whether a stage pauses.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Actor } from "./ops/define";
import { isOperationError } from "./ops/errors";
import { type InvokeResult, invoke } from "./ops/invoke";
import "./ops/operations";

export interface WorkItemParams {
  workItemId: string;
}

export type WorkItemOutcome =
  | { status: "done"; workItemId: string }
  | { status: "rejected" | "expired" | "failed"; workItemId: string; reason: string };

/** A step's result is journaled, so it must be serializable. The spike's outputs are flat records. */
type Json = Record<string, string | number | boolean | null>;
type StepResult =
  | (Omit<Extract<InvokeResult, { status: "ok" }>, "output"> & { output: Json })
  | Extract<InvokeResult, { status: "pending" }>
  | { status: "refused"; code: string; message: string; killEpoch: number | null };

const FOREMAN: Actor = { type: "agent", id: "foreman" };
const RUNNER: Actor = { type: "runner", id: "runner-stub" };

/** How long a gate waits for a human before the work item expires. */
export const GATE_TIMEOUT = "7 days";
/** How long a step refused by the kill switch waits for it to be turned off. */
export const PARK_TIMEOUT = "30 days";

export class WorkItemWorkflow extends WorkflowEntrypoint<Env, WorkItemParams> {
  override async run(
    event: WorkflowEvent<WorkItemParams>,
    step: WorkflowStep,
  ): Promise<WorkItemOutcome> {
    const { workItemId } = event.payload;
    const workflowId = event.instanceId;

    /**
     * One journaled step = one operation call. Refusals are results, not retries. A step the kill
     * switch refused parks until the switch is turned off, then runs again under a new step name.
     */
    const call = async (
      name: string,
      op: string,
      input: unknown,
      actor = FOREMAN,
      approvalId?: string,
    ): Promise<StepResult> => {
      for (let attempt = 1; ; attempt++) {
        const stepName = attempt === 1 ? name : `${name} #${attempt}`;
        const result = await step.do<StepResult>(
          stepName,
          { retries: { limit: 3, delay: "1 second", backoff: "exponential" } },
          async () => {
            try {
              return (await invoke(this.env, op, input, {
                actor,
                origin: { surface: "workflow", workflowId, step: stepName },
                idempotencyKey: `${workflowId}:${stepName}`,
                ...(approvalId ? { approvalId } : {}),
              })) as StepResult;
            } catch (error) {
              if (!isOperationError(error)) throw error;
              const killEpoch = (error.details as { killEpoch?: number } | undefined)?.killEpoch;
              return {
                status: "refused",
                code: error.code,
                message: error.message,
                killEpoch: killEpoch ?? null,
              } as StepResult;
            }
          },
        );
        if (result.status !== "refused" || result.code !== "killed") return result;
        await step.waitForEvent(`${stepName}: parked`, {
          type: `factory-resume-${result.killEpoch}`,
          timeout: PARK_TIMEOUT,
        });
      }
    };

    const end = async (status: "rejected" | "expired" | "failed", reason: string) => {
      await call(`close: ${status}`, "workItem.close", { workItemId, status, reason });
      return { status, workItemId, reason } as WorkItemOutcome;
    };
    const refused = (result: StepResult) =>
      result.status === "refused" ? end("failed", result.message) : null;

    /**
     * Calls an operation; when the gate says `review`, waits for `approval-<pendingActionId>` and
     * re-runs it with the approval. Returns the operation's output, or how the work item ended.
     */
    const gated = async (
      name: string,
      op: string,
      input: unknown,
    ): Promise<{ output: unknown } | { ended: WorkItemOutcome }> => {
      const first = await call(`${name}: request`, op, input);
      const stop = refused(first);
      if (stop) return { ended: await stop };
      if (first.status === "ok") return { output: first.output };
      if (first.status !== "pending") throw new Error("unreachable");

      let decision: string;
      try {
        const approval = await step.waitForEvent<{ decision: string }>(`${name}: wait`, {
          type: `approval-${first.pendingActionId}`,
          timeout: GATE_TIMEOUT,
        });
        decision = approval.payload.decision;
      } catch {
        return { ended: await end("expired", `${name} gate timed out`) };
      }
      if (decision !== "approved") return { ended: await end("rejected", `${name} rejected`) };

      const applied = await call(`${name}: apply`, op, input, FOREMAN, first.pendingActionId);
      const stopApplied = refused(applied);
      if (stopApplied) return { ended: await stopApplied };
      if (applied.status !== "ok") throw new Error(`${op} still pending after approval`);
      return { output: applied.output };
    };

    // Triage (stub): the size comes from intake, else from the body's length.
    const size = await step.do("triage: size", async () => {
      const row = await this.env.DB.prepare(`SELECT size, body FROM work_items WHERE id = ?`)
        .bind(workItemId)
        .first<{ size: string | null; body: string }>();
      if (!row) throw new Error(`work item ${workItemId} not found`);
      return (row.size ?? (row.body.length > 280 ? "large" : "small")) as "small" | "large";
    });
    const triaged = await call("triage: record", "workItem.triage", {
      workItemId,
      size,
      route: size === "small" ? "skip spec" : "spec gate",
    });
    const stopTriage = refused(triaged);
    if (stopTriage) return stopTriage;

    // Spec gate: only bigger work needs a spec; `plan` is reviewed in every preset (ADR 0013).
    if (size === "large") {
      const spec = await gated("spec", "spec.accept", {
        workItemId,
        spec: "Stub spec: acceptance criteria would be written here.",
      });
      if ("ended" in spec) return spec.ended;
    }

    // Build (stub): stands in for a runner job (claim → workspace → harness → hand back).
    const branch = `factory/${workItemId}`;
    const built = await call(
      "build: runner job",
      "build.record",
      { workItemId, branch, commit: "0000000" },
      RUNNER,
    );
    const stopBuild = refused(built);
    if (stopBuild) return stopBuild;

    // Verify (stub): the review packet's checks.
    const verified = await call("verify: review packet", "verify.record", {
      workItemId,
      checks: { tests: "pass", lint: "pass", typecheck: "pass" },
    });
    const stopVerify = refused(verified);
    if (stopVerify) return stopVerify;
    if (verified.status === "ok" && !(verified.output as { passed: boolean }).passed) {
      return end("failed", "verification failed");
    }

    // Merge gate: `merge` is always reviewed for agents.
    const merged = await gated("merge", "pr.merge", { workItemId, branch });
    if ("ended" in merged) return merged.ended;
    return { status: "done", workItemId };
  }
}
