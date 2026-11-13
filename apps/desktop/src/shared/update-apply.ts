// "Restart to update", step by step (spec 40 M4): what the window shows from the click until the
// app restarts. The click shows "Updating to <version>" at once; the steps are the update's
// signature checked (cheap when it was checked at download: updates.ts), the runner asked to stop
// taking jobs, then the restart. A refused update shows why, with a way back; a runner that is busy
// (or doesn't answer) goes back to idle, and the app updates once it is idle (index.ts).
// Pure, for the tests: the main process holds the state and pushes it with the update status.

export type ApplyStep = "idle" | "verifying" | "waiting" | "restarting" | "refused";

export interface ApplyState {
  step: ApplyStep;
  /** The version being installed. */
  version: string | null;
  /** Refused: why, in plain words (the updater's refusal message). */
  reason: string | null;
}

export type ApplyEvent =
  | { type: "start"; version: string }
  /** The runner is asked to stop taking jobs (bounded wait). */
  | { type: "waiting" }
  /** Checked, the runner is idle: the app is restarting. */
  | { type: "restarting" }
  | { type: "refused"; reason: string }
  /** The runner has jobs, or didn't answer: the update waits for idle. */
  | { type: "deferred" }
  /** The person read the refusal and goes back. */
  | { type: "back" };

export const IDLE: ApplyState = { step: "idle", version: null, reason: null };

/** The next state, or the same one for an event that doesn't apply where it is. */
export function applyTransition(s: ApplyState, e: ApplyEvent): ApplyState {
  switch (e.type) {
    case "start":
      // One restart at a time: a second click while one runs changes nothing.
      return s.step === "idle" ? { step: "verifying", version: e.version, reason: null } : s;
    case "waiting":
      return s.step === "verifying" ? { ...s, step: "waiting" } : s;
    case "restarting":
      return s.step === "verifying" || s.step === "waiting" ? { ...s, step: "restarting" } : s;
    case "refused":
      return s.step === "idle" || s.step === "refused"
        ? s
        : { ...s, step: "refused", reason: e.reason };
    case "deferred":
      return s.step === "verifying" || s.step === "waiting" ? IDLE : s;
    case "back":
      return s.step === "refused" ? IDLE : s;
  }
}

/** The line under "Updating to <version>" for each step. */
export function applyStepText(step: ApplyStep): string {
  switch (step) {
    case "verifying":
      return "Checking the update's signature…";
    case "waiting":
      return "Waiting for this Mac's runner to stop taking jobs…";
    case "restarting":
      return "Restarting…";
    case "refused":
      return "The update was refused.";
    case "idle":
      return "";
  }
}
