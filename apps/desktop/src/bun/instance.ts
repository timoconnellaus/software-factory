// One app per user (ADR 0390). macOS usually prevents a second copy, but launching the binary
// directly doesn't: a pid lock makes the second one quit. And if the launcher dies the Bun process
// is orphaned (the spike saw this), so a watchdog quits it, stopping the runner, when that happens.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** True when this process now holds the lock. */
export function acquireInstanceLock(dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "app.pid");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      process.on("exit", () => {
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file);
        } catch {
          // gone
        }
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(holder) && holder !== process.pid && alive(holder)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

/**
 * Calls `onOrphaned` once the launcher that started us is gone. Bun's `process.ppid` doesn't change
 * after start, so this checks the parent itself is still alive.
 */
export function watchParent(onOrphaned: () => void, everyMs = 2000): void {
  const parent = process.ppid;
  if (parent <= 1) return;
  const t = setInterval(() => {
    if (!alive(parent)) {
      clearInterval(t);
      onOrphaned();
    }
  }, everyMs);
}
