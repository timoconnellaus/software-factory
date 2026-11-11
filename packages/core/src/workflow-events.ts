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

/**
 * CI on a work item's head SHA settled (the GitHub connector saw a check suite complete): payload
 * `{ state }`. The Workflow re-reads CI after it, so a missed or early event only costs a timeout.
 */
export const ciEvent = (workItemId: string, sha: string) => `ci-${workItemId}-${sha}`;

/**
 * A work item's merge queue entry may have reached the head of its project's queue (ADR 0330). Sent
 * when the entry ahead leaves; the Workflow re-reads its position after it, so a missed or extra
 * event only costs a timeout.
 */
export const mergeQueueEvent = (workItemId: string) => `mergeq-${workItemId}`;
