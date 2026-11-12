// One runner host per machine (ADR 0390, spec 40 M2): two hosts with the same runner identity would
// fight over leases. `sf-runner run` takes a pid lock in its state directory; a second one refuses
// to start while the first is alive. A lock left by a dead process is taken over.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export class HostLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another sf-runner host is already running (pid ${pid}); stop it first`);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, which still counts as running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes the lock or throws HostLockedError. Returns a release function. */
export function acquireHostLock(stateDir: string, pid = process.pid): () => void {
  const file = join(stateDir, "host.pid");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, "utf8").trim() === String(pid)) rmSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
        throw new HostLockedError(holder);
      }
      rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  throw new Error(`couldn't take the host lock at ${file}`);
}
