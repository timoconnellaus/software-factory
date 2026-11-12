// The jobs this Mac's runner is running, read from the file the runner host keeps for exactly this
// (local/runner-host/src/live-jobs.ts: `<state dir>/live-jobs.json`, naming its writer's pid).
// The updater uses it: no job is cancelled for an update (spec 38's rule), so "Restart to update"
// waits until the runner is idle, unless the person chooses to restart anyway.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the runner host writes it, with the same defaults as local/runner-host/src/config.ts. */
export function liveJobsFile(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME ?? homedir();
  const stateDir =
    env.SF_RUNNER_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "software-factory", "runner");
  return join(stateDir, "live-jobs.json");
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The live job ids; [] when no runner host is running (no file, or its writer is gone). An
 * unreadable file counts as idle: the runner host rewrites it on every change.
 */
export function liveJobs(
  file = liveJobsFile(),
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  isAlive: (pid: number) => boolean = alive,
): string[] {
  try {
    const doc = JSON.parse(read(file)) as { pid?: unknown; jobs?: unknown };
    if (typeof doc.pid !== "number" || !Array.isArray(doc.jobs) || !isAlive(doc.pid)) return [];
    return doc.jobs.filter((j): j is string => typeof j === "string");
  } catch {
    return [];
  }
}
