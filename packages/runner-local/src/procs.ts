// Stopping a job's processes for certain (spec 43, ADR 0550; incident #11 (2026-11-12)). A job's
// Claude runs the harness's launch script, which `exec`s Claude with `--settings
// <runDir>/claude-settings.json`: that path is on Claude's command line for as long as it runs,
// and no other process's. So the job's live harness is "every process whose command line contains
// the run's settings path", read from `ps`, never guessed from a pid file (a stale pid may belong
// to anything by now).
//
// The launch script is a process-group leader: tmux starts each pane with forkpty(), which calls
// setsid(), so the pane's first process (`exec /bin/sh launch.sh`, then `exec claude`) leads its
// own session and group; a stream session is spawned `detached` (setsid) for the same reason. The
// tools Claude runs inherit the group. Stopping a job signals that group (TERM, then KILL after a
// grace period), and the descendants that left it, then checks the settings path is gone from
// `ps`. When it isn't, the caller hears it (`HarnessStillRunning`): a job is never reported
// released while its process may still be alive.
import { ReleaseIncomplete } from "@software-factory/runner-contract";
import { type Exec, nodeExec } from "./exec.ts";

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** How processes are read and signalled. Injectable for tests; the default is `ps` and `kill`. */
export interface Procs {
  list(): Promise<Proc[]>;
  /** `process.kill`: a negative pid is a group. Throws ESRCH when it's gone. */
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  /** This process's group: never signalled. */
  ownGroup(): Promise<number | null>;
}

/** `ps -A -ww -o pid=,ppid=,pgid=,command=` (BSD and procps both read it). */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] ?? "" });
  }
  return out;
}

export function hostProcs(exec: Exec = nodeExec, timeoutMs = 30_000): Procs {
  let own: number | null | undefined;
  const list = async () => {
    const r = await exec("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], { timeoutMs });
    if (r.code !== 0 || r.timedOut) {
      throw new Error(`ps ${r.timedOut ? "timed out" : `exited ${r.code}`}: ${r.stderr.trim()}`);
    }
    return parsePs(r.stdout);
  };
  return {
    list,
    kill: (pid, signal) => process.kill(pid, signal),
    async ownGroup() {
      if (own !== undefined) return own;
      own = (await list().catch(() => [])).find((p) => p.pid === process.pid)?.pgid ?? null;
      return own;
    },
  };
}

/** The job's still-running processes were found after they were told to stop. */
export class HarnessStillRunning extends ReleaseIncomplete {
  override name = "HarnessStillRunning";
  constructor(
    readonly settingsPath: string,
    readonly pids: number[],
    detail?: string,
  ) {
    super(
      detail ??
        `the job's Claude is still running after TERM and KILL (pids ${pids.join(", ")}, ${settingsPath})`,
    );
  }
}

/** The processes running a run's harness: their command line has its settings path. */
export async function harnessProcesses(procs: Procs, settingsPath: string): Promise<Proc[]> {
  return (await procs.list()).filter((p) => p.command.includes(settingsPath));
}

/**
 * Whether a run's harness may still be running: true when `ps` shows its settings path, false when
 * it doesn't, and true when `ps` can't be read (unknown counts as alive).
 */
export async function harnessMayBeAlive(procs: Procs, settingsPath: string): Promise<boolean> {
  try {
    return (await harnessProcesses(procs, settingsPath)).length > 0;
  } catch {
    return true;
  }
}

const gone = (procs: Procs, pid: number) => {
  try {
    procs.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};

export interface StopOptions {
  /** How long the job gets to exit after TERM (default 5 s). */
  termGraceMs?: number;
  /** How long after KILL before it counts as surviving (default 3 s). */
  killGraceMs?: number;
  pollMs?: number;
}

/**
 * Stops every process of a run (TERM → KILL) and verifies none is left. Resolves with the pids it
 * signalled (empty when nothing was running); throws `HarnessStillRunning` when something is, or
 * when `ps` can't be read to tell.
 */
export async function stopHarness(
  procs: Procs,
  settingsPath: string,
  options: StopOptions = {},
): Promise<number[]> {
  const termGraceMs = options.termGraceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 3_000;
  const pollMs = options.pollMs ?? 100;
  const list = async () => {
    try {
      return await procs.list();
    } catch (err) {
      // Once more: a slow `ps` under load is not proof of anything.
      return procs.list().catch(() => {
        throw new HarnessStillRunning(
          settingsPath,
          [],
          `can't tell whether the job's Claude stopped: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  };
  const all = await list();
  const roots = all.filter((p) => p.command.includes(settingsPath));
  if (roots.length === 0) return [];
  const own = await procs.ownGroup();
  const safe = (pgid: number) => pgid > 1 && pgid !== own && pgid !== process.pid;
  // The roots' groups (a root leads its own: the pane, or a detached stream session), and every
  // descendant that left the group (a tool that called setsid), found before anything dies and
  // is re-parented.
  const groups = new Set(roots.filter((p) => p.pgid === p.pid && safe(p.pgid)).map((p) => p.pgid));
  const singles = new Set<number>();
  const children = new Map<number, Proc[]>();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const walk = [...roots];
  while (walk.length) {
    const p = walk.pop() as Proc;
    if (!groups.has(p.pgid) && p.pid !== process.pid) singles.add(p.pid);
    for (const c of children.get(p.pid) ?? []) walk.push(c);
  }
  const signal = (sig: NodeJS.Signals) => {
    for (const g of groups) {
      try {
        procs.kill(-g, sig);
      } catch {
        // Gone already.
      }
    }
    for (const pid of singles) {
      try {
        procs.kill(pid, sig);
      } catch {
        // Gone already.
      }
    }
  };
  const allGone = () =>
    [...groups].every((g) => gone(procs, -g)) && [...singles].every((p) => gone(procs, p));
  const waitGone = async (ms: number) => {
    const until = Date.now() + ms;
    while (!allGone() && Date.now() < until) await new Promise((r) => setTimeout(r, pollMs));
  };
  signal("SIGTERM");
  await waitGone(termGraceMs);
  if (!allGone()) {
    signal("SIGKILL");
    await waitGone(killGraceMs);
  }
  const left = (await list()).filter((p) => p.command.includes(settingsPath));
  if (left.length > 0) {
    throw new HarnessStillRunning(
      settingsPath,
      left.map((p) => p.pid),
    );
  }
  return [...new Set([...groups, ...singles])];
}
