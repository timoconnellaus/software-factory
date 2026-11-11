// Event types the work-item Workflow waits on (ADR 0006, spike ADR 0110). Operations send them via
// the outbox; sf-engine's Workflow waits for them. Each is unique per wait, so a late or repeated
// event can never release a later wait.

/** A pending action was decided: payload `GateEventPayload`. */
export const approvalEvent = (pendingActionId: string) => `approval-${pendingActionId}`;

/** A job's run finished (handed back, failed, cancelled, expired): payload `RunEventPayload`. */
export const runEvent = (jobId: string) => `run-${jobId}`;

/** The last open blocking question of a planning round was answered. */
export const questionsEvent = (workItemId: string, round: number) =>
  `questions-${workItemId}-${round}`;

export interface GateEventPayload {
  decision: "approved" | "rejected" | "changes_requested" | "sent_back";
  note: string | null;
  by: string;
}

export interface RunEventPayload {
  runId: string;
  outcome: "completed" | "failed" | "timed_out" | "cancelled" | "stalled";
  reason: string | null;
}
