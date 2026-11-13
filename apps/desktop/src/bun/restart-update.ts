// "Restart to update" (spec 40 M4): no job is cancelled for an update unless the person chose to.
// Reading the live jobs and then stopping the runner leaves a window in which it claims one, so the
// runner is first asked to stop claiming (it then rewrites its live-jobs file once any claim in
// flight has landed), the jobs are read again, and only an idle runner is stopped. Whatever
// happens, a runner and live socket that were stopped come back if the app is still running.
// While the drain is in flight the app shows "Waiting for the runner" with its deadline (`waiting`),
// and the wait is bounded (DRAIN_TIMEOUT_MS) even if the runner never answers: a runner that
// doesn't confirm in time is reported as "timeout" and the app updates once it is idle instead.
// Applying is bounded too (APPLY_TIMEOUT_MS): Electrobun's applyUpdate quits the app once the
// helper has the plan, so one still pending after that has hung (it or the helper). It is reported
// as "stalled", and the runner and live socket come back, so the window never sits on
// "Restarting…" for good. The apply given up on is cancelled: it asks the gate immediately before
// handing off to Electrobun's applyUpdate, and a cancelled one stops there, so the app is never
// replaced under a window that says it didn't restart. Once the handoff has started there is no
// bring-back: the helper may already be replacing the app, so the window stays on "Restarting…",
// but not for ever: past STUCK_TIMEOUT_MS it is reported as "stuck" and the window asks the person
// to quit and reopen the app. The runner is never started again in-process then: the app may be
// half replaced, and a fresh launch is what knows which version it is.
// Nothing here imports Electrobun, so the tests run on Node.

/** How long "Restart to update" waits for the runner to confirm it has stopped claiming. */
export const DRAIN_TIMEOUT_MS = 30_000;
/** How long applying may take before the restart counts as stuck. */
export const APPLY_TIMEOUT_MS = 90_000;
/** How long a handed-off apply may hang before the window says to quit and reopen the app. */
export const STUCK_TIMEOUT_MS = 5 * 60_000;

export interface RestartDeps {
  /**
   * Ask the runner to stop claiming and wait until it has said so. "confirmed": its job list is
   * now final; "not-ours": the app doesn't run it (launchd, unpaired, stopped); "timeout".
   */
  drain(timeoutMs: number): Promise<"confirmed" | "not-ours" | "timeout">;
  /** The drain started (with the time it gives up, epoch ms) or ended (null): the app shows it. */
  waiting?(until: number | null): void;
  now?(): number;
  /** The runner is idle (or the person chose to cancel its jobs): the app stops it and restarts. */
  restarting?(): void;
  liveJobs(): string[];
  stopLive(): void;
  startLive(): void;
  stopRunner(): Promise<void>;
  startRunner(): void;
  /**
   * Restarts into the update; returns only when it didn't. It calls `gate.handoff()` immediately
   * before handing off to the updater, and stops there (returns) when that says false.
   */
  apply(gate: ApplyGate): Promise<void>;
  log?(line: string): void;
}

/** The point of no return in applying, decided once: whichever of handoff and cancel comes first. */
export interface ApplyGate {
  /** True: go ahead (the watchdog won't bring anything back now). False: cancelled, don't apply. */
  handoff(): boolean;
  /** The watchdog gave up before the handoff: it has already said the app didn't restart. */
  cancelled(): boolean;
}

/**
 * "deferred": a job turned up: wait for idle, the runner stays drained meanwhile. "timeout": the
 * runner didn't confirm the drain in time: wait for idle too. "failed": the update didn't start and
 * everything was brought back. "stalled": applying didn't return or restart within
 * APPLY_TIMEOUT_MS; everything was brought back too. "stuck": handed off to the updater, which
 * neither restarted the app nor returned within STUCK_TIMEOUT_MS: nothing is brought back.
 */
export async function restartToUpdate(
  d: RestartDeps,
  opts: { anyway: boolean; timeoutMs?: number; applyTimeoutMs?: number; stuckTimeoutMs?: number },
): Promise<"deferred" | "timeout" | "failed" | "stalled" | "stuck"> {
  if (!opts.anyway) {
    const timeoutMs = opts.timeoutMs ?? DRAIN_TIMEOUT_MS;
    d.waiting?.((d.now ?? Date.now)() + timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drained: "confirmed" | "not-ours" | "timeout";
    try {
      // The runner's own wait is bounded too; this bounds what the person is shown either way.
      drained = await Promise.race([
        d.drain(timeoutMs),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs + 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      d.waiting?.(null);
    }
    if (drained === "timeout") return "timeout";
    if (d.liveJobs().length > 0) return "deferred";
  }
  d.restarting?.();
  d.stopLive();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  // "open" until one of them happens: the handoff to the updater, or the watchdog giving up.
  let gateState: "open" | "handed-off" | "cancelled" = "open";
  const gate: ApplyGate = {
    handoff: () => {
      if (gateState === "cancelled") return false;
      gateState = "handed-off";
      return true;
    },
    cancelled: () => gateState === "cancelled",
  };
  const applyMs = opts.applyTimeoutMs ?? APPLY_TIMEOUT_MS;
  const stuckMs = Math.max(applyMs, opts.stuckTimeoutMs ?? STUCK_TIMEOUT_MS);
  let stuck = false;
  let late: ReturnType<typeof setTimeout> | undefined;
  try {
    await d.stopRunner();
    const applying = d.apply(gate).then(() => "returned" as const);
    const applied = await Promise.race([
      applying,
      new Promise<"stalled">((resolve) => {
        watchdog = setTimeout(() => resolve("stalled"), applyMs);
      }),
    ]);
    if (applied === "stalled") {
      if (gateState === "open") {
        // Not handed off yet: cancelled, so the apply still running stops before applyUpdate.
        gateState = "cancelled";
        return "stalled";
      }
      // Handed off: the app may be being replaced right now. Nothing comes back; it either
      // restarts or applyUpdate returns (didn't restart), and only then is everything brought back.
      d.log?.(
        `updates: restart to update: still restarting after ${applyMs / 1000} s; the updater has the update, so waiting for it`,
      );
      const after = await Promise.race([
        applying,
        new Promise<"stuck">((resolve) => {
          late = setTimeout(() => resolve("stuck"), stuckMs - applyMs);
        }),
      ]);
      if (after === "stuck") {
        d.log?.(
          `updates: restart to update: no restart and no return after ${stuckMs / 1000} s: asking the person to quit and reopen the app`,
        );
        stuck = true;
        return "stuck";
      }
    }
  } finally {
    clearTimeout(watchdog);
    clearTimeout(late);
    // Still running: the update didn't start (or something threw, or it hung, on the way). Not
    // when stuck after the handoff: the app may be half replaced, so only a relaunch decides.
    if (!stuck) {
      d.startRunner();
      d.startLive();
    }
  }
  return "failed";
}
