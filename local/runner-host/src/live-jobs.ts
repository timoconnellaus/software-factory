// The jobs a running host holds, in a small file next to its state, so `sf-runner status` and
// `sf-runner doctor` (separate processes) can tell a live job's worktree from an orphan, and so the
// owner can see when it is safe to upgrade the runner. The file names its writer's pid: a file
// left by a host that is no longer running means no live jobs.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LiveJobs {
  pid: number;
  jobs: string[];
  updatedAt: string;
}

export async function writeLiveJobs(file: string, jobs: string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: LiveJobs = { pid: process.pid, jobs, updatedAt: new Date().toISOString() };
  await writeFile(tmp, `${JSON.stringify(body)}\n`);
  await rename(tmp, file);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The live jobs, or `null` when no host is running (no file, or its writer is gone). */
export async function readLiveJobs(
  file: string,
  isAlive: (pid: number) => boolean = alive,
): Promise<LiveJobs | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as LiveJobs;
    if (!Array.isArray(parsed.jobs) || typeof parsed.pid !== "number") return null;
    return isAlive(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
}
