// "Restart to update", step by step (spec 40 M4): what the window shows from the click until the
// app restarts. The click shows "Updating to <version>" at once; the steps are the update's
// signature checked (cheap when it was checked at download: updates.ts), the runner asked to stop
// taking jobs, then the restart. A refused update shows why, with a way back; a runner that is busy
// (or doesn't answer) goes back to idle, and the app updates once it is idle (index.ts). A restart
// handed to the updater that neither restarts nor returns for minutes is `stuck`: the only way on is
// to quit and reopen the app.
// Pure, for the tests: the main process holds the state and pushes it with the update status.

export type ApplyStep = "idle" | "verifying" | "waiting" | "restarting" | "refused" | "stuck";

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
  /** Handed to the updater, which neither restarted nor returned (restart-update.ts). */
  | { type: "stuck" }
  /** The runner has jobs, or didn't answer: the update waits for idle. */
  | { type: "deferred" }
  /** The person read the refusal and goes back. */
  | { type: "back" };

export const IDLE: ApplyState = { step: "idle", version: null, reason: null };

/** The next state, or the same one for an event that doesn't apply where it is. */
export function applyTransition(s: ApplyState, e: ApplyEvent): ApplyState {
  switch (e.type) {
    case "start":
      // One restart at a time: a second click while one runs changes nothing. From a refusal (the
      // screen still up, or a tray click while it is) a new try starts over.
      return s.step === "idle" || s.step === "refused"
        ? { step: "verifying", version: e.version, reason: null }
        : s;
    case "waiting":
      return s.step === "verifying" ? { ...s, step: "waiting" } : s;
    case "restarting":
      return s.step === "verifying" || s.step === "waiting" ? { ...s, step: "restarting" } : s;
    case "refused":
      // Stuck stays stuck: only quitting moves on from it.
      return s.step === "idle" || s.step === "refused" || s.step === "stuck"
        ? s
        : { ...s, step: "refused", reason: e.reason };
    case "stuck":
      return s.step === "restarting" ? { ...s, step: "stuck", reason: STUCK_TEXT } : s;
    case "deferred":
      return s.step === "verifying" || s.step === "waiting" ? IDLE : s;
    case "back":
      return s.step === "refused" ? IDLE : s;
  }
}

export const STUCK_TEXT = "The update is taking too long. Quit and reopen the app.";

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
    case "stuck":
      return STUCK_TEXT;
    case "idle":
      return "";
  }
}
