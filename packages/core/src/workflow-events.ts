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
  /** `withdrawn`: an attached PR's head moved while its merge gate was open (spec 05). */
  decision: "approved" | "rejected" | "changes_requested" | "sent_back" | "withdrawn";
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
 * An attached PR's head changed (spec 05): `verify.refresh` saw a push to it and recorded the new
 * `head_sha`. Payload `{ headSha }`. The same type repeats per push, so the Workflow re-reads the
 * item's head after waking and waits again when it hasn't moved.
 */
export const prHeadEvent = (workItemId: string) => `pr-head-${workItemId}`;

/**
 * A work item's merge queue entry may have reached the head of its project's queue (ADR 0330). Sent
 * when the entry ahead leaves; the Workflow re-reads its position after it, so a missed or extra
 * event only costs a timeout.
 */
export const mergeQueueEvent = (workItemId: string) => `mergeq-${workItemId}`;

/**
 * The babysitter finished delivering a work item (spec 53, ADR 0580): payload
 * `DeliveredEventPayload`. Sent once, when its queue entry ends. The outcome is also on the entry
 * (`mergeQueue.position`), so a Workflow that missed it reads it back after a timeout.
 */
export const deliveredEvent = (workItemId: string) => `delivered-${workItemId}`;

export interface DeliveredEventPayload {
  /** `withdrawn`: the approval no longer holds for the head (ADR 0582); it goes back to the gate. */
  outcome: "merged" | "conflict" | "failed" | "withdrawn";
  reason: string;
  /** The entry's head when it ended: for `withdrawn`, the head to decide again. */
  headSha?: string;
}

/**
 * A shaped work item was released and pulled (ADR 0493): its Workflow, waiting at `release: wait`
 * after the shaping stages, goes on to delivery. Sent once, by the pull that starts it.
 */
export const releaseEvent = (workItemId: string) => `release-${workItemId}`;
