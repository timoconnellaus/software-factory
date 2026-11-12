// "Restart to update" (spec 40 M4): no job is cancelled for an update unless the person chose to.
// Reading the live jobs and then stopping the runner leaves a window in which it claims one, so the
// runner is first asked to stop claiming (it then rewrites its live-jobs file once any claim in
// flight has landed), the jobs are read again, and only an idle runner is stopped. Whatever
// happens, a runner and live socket that were stopped come back if the app is still running.
// Nothing here imports Electrobun, so the tests run on Node.

export interface RestartDeps {
  /**
   * Ask the runner to stop claiming and wait until it has said so. "confirmed": its job list is
   * now final; "not-ours": the app doesn't run it (launchd, unpaired, stopped); "timeout".
   */
  drain(): Promise<"confirmed" | "not-ours" | "timeout">;
  liveJobs(): string[];
  stopLive(): void;
  startLive(): void;
  stopRunner(): Promise<void>;
  startRunner(): void;
  /** Restarts into the update; returns only when it didn't. */
  apply(): Promise<void>;
}

/**
 * "deferred": a job turned up (or the runner didn't answer): wait for idle, the runner stays
 * drained meanwhile. "failed": the update didn't start and everything was brought back.
 */
export async function restartToUpdate(
  d: RestartDeps,
  opts: { anyway: boolean },
): Promise<"deferred" | "failed"> {
  if (!opts.anyway) {
    const drained = await d.drain();
    if (drained === "timeout" || d.liveJobs().length > 0) return "deferred";
  }
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
