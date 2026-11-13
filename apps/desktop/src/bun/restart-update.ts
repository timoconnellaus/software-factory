// "Restart to update" (spec 40 M4): no job is cancelled for an update unless the person chose to.
// Reading the live jobs and then stopping the runner leaves a window in which it claims one, so the
// runner is first asked to stop claiming (it then rewrites its live-jobs file once any claim in
// flight has landed), the jobs are read again, and only an idle runner is stopped. Whatever
// happens, a runner and live socket that were stopped come back if the app is still running.
// While the drain is in flight the app shows "Waiting for the runner" with its deadline (`waiting`),
// and the wait is bounded (DRAIN_TIMEOUT_MS) even if the runner never answers: a runner that
// doesn't confirm in time is reported as "timeout" and the app updates once it is idle instead.
// Nothing here imports Electrobun, so the tests run on Node.

/** How long "Restart to update" waits for the runner to confirm it has stopped claiming. */
export const DRAIN_TIMEOUT_MS = 30_000;

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
  /** Restarts into the update; returns only when it didn't. */
  apply(): Promise<void>;
}

/**
 * "deferred": a job turned up: wait for idle, the runner stays drained meanwhile. "timeout": the
 * runner didn't confirm the drain in time: wait for idle too. "failed": the update didn't start and
 * everything was brought back.
 */
export async function restartToUpdate(
  d: RestartDeps,
  opts: { anyway: boolean; timeoutMs?: number },
): Promise<"deferred" | "timeout" | "failed"> {
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
  try {
    await d.stopRunner();
    await d.apply();
  } finally {
    // Still running: the update didn't start (or something threw on the way).
    d.startRunner();
    d.startLive();
  }
  return "failed";
}
