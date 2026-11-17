// After a crash, and for `sf-runner doctor`: this runner's job containers whose job it no longer
// runs (ADR 0661). Their job dirs are under the worktrees dir, which runner-local's reaper clears.
import { JOB_LABEL, RUNNER_LABEL } from "./adapter.ts";
import type { ContainerRuntime } from "./runtime.ts";

/** Removes this runner's containers whose job isn't in `running`. Returns their job ids. */
export async function reapContainers(
  runtime: ContainerRuntime,
  runnerId: string,
  running: Set<string>,
): Promise<string[]> {
  const reaped: string[] = [];
  for (const c of await runtime.containers(`${RUNNER_LABEL}=${runnerId}`)) {
    const jobId = c.labels[JOB_LABEL];
    if (!jobId || running.has(jobId)) continue;
    await runtime.remove(c.name);
    reaped.push(jobId);
  }
  return reaped;
}
