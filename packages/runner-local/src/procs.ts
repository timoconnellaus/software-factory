// Stopping a job's processes for certain (spec 43, ADR 0550; incident #11 (2026-11-12)). A job's
// Claude runs the harness's launch script, which `exec`s Claude with `--settings
// <runDir>/claude-settings.json`: that argument is on Claude's command line for as long as it runs.
// So the job's live harness is "every process of the runner's own user whose command line has
// `--settings <the run's settings path>`", read from `ps`, never guessed from a pid file (a stale
// pid may belong to anything by now). A process that merely names the file (the owner's `less` or
// `tail` on it, a grep over the runs dir) isn't one; nor is another user's.
//
// The launch script is a process-group leader: tmux starts each pane with forkpty(), which calls
// setsid(), so the pane's first process (`exec /bin/sh launch.sh`, then `exec claude`) leads its
// own session and group; a stream session is spawned `detached` (setsid) for the same reason. The
// tools Claude runs inherit the group. Stopping a job signals that group (TERM, then KILL after a
// grace period), the descendants that left it, and, given the job's worktree, the runner user's
// processes already re-parented to init whose working directory is in it (a dev server started
// with `setsid` or `nohup`). Then it checks they are gone. When they aren't, the caller hears it
// (`HarnessStillRunning`): a job is never reported released while its process may still be alive.
import { readlink } from "node:fs/promises";
import { sep } from "node:path";
import { ReleaseIncomplete } from "@software-factory/runner-contract";
import { type Exec, nodeExec } from "./exec.ts";

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  /** The process's user; absent when the lister can't say (then it counts as the runner's). */
  uid?: number;
  command: string;
}

/** How processes are read and signalled. Injectable for tests; the default is `ps` and `kill`. */
export interface Procs {
  list(): Promise<Proc[]>;
  /** `process.kill`: a negative pid is a group. Throws ESRCH when it's gone. */
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  /** This process's group: never signalled. */
  ownGroup(): Promise<number | null>;
  /** The runner's own user: only its processes are ever the job's. */
  uid?(): number | null;
  /** The working directories of some processes (best effort: missing ones are left out). */
  cwds?(pids: number[]): Promise<Map<number, string>>;
}

/** `ps -A -ww -o pid=,ppid=,pgid=,uid=,command=` (BSD and procps both read it). */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      command: m[5] ?? "",
    });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a command line runs a harness with this settings file (`--settings <path>`). */
export function runsWithSettings(command: string, settingsPath: string): boolean {
  return new RegExp(`(^|\\s)--settings(=|\\s+)${escapeRe(settingsPath)}(\\s|$)`).test(command);
}

export function hostProcs(exec: Exec = nodeExec, timeoutMs = 30_000): Procs {
  let own: number | null | undefined;
  const list = async () => {
    const r = await exec("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,uid=,command="], {
      timeoutMs,
    });
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
    uid: () => process.getuid?.() ?? null,
    async cwds(pids) {
      const out = new Map<number, string>();
      if (pids.length === 0) return out;
      if (process.platform === "linux") {
        for (const pid of pids) {
          const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
          if (cwd) out.set(pid, cwd);
        }
        return out;
      }
      // macOS: lsof's field output, `p<pid>` then `n<cwd>`.
      const r = await exec("lsof", ["-w", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], {
        timeoutMs,
      });
      let pid = 0;
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
      }
      return out;
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
        `the job's processes are still running after TERM and KILL (pids ${pids.join(", ")}, ${settingsPath})`,
    );
  }
}

/** The runner user's processes, as far as the lister can tell. */
function ours(procs: Procs, all: Proc[]): Proc[] {
  const uid = procs.uid?.() ?? null;
  return uid === null ? all : all.filter((p) => p.uid === undefined || p.uid === uid);
}

/** The processes running a run's harness: the runner's, with `--settings <settingsPath>`. */
export async function harnessProcesses(procs: Procs, settingsPath: string): Promise<Proc[]> {
  return ours(procs, await procs.list()).filter((p) => runsWithSettings(p.command, settingsPath));
}

/**
 * Whether a run's harness may still be running: true when `ps` shows it, false when it doesn't, and
 * true when `ps` can't be read (unknown counts as alive).
 */
export async function harnessMayBeAlive(procs: Procs, settingsPath: string): Promise<boolean> {
  try {
    return (await harnessProcesses(procs, settingsPath)).length > 0;
  } catch {
    return true;
  }
}

/** Gone, or not ours to signal (EPERM: another user's, never the job's). */
const gone = (procs: Procs, pid: number) => {
  try {
    procs.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ESRCH" || code === "EPERM";
  }
};

export interface StopOptions {
  /** How long the job gets to exit after TERM (default 5 s). */
  termGraceMs?: number;
  /** How long after KILL before it counts as surviving (default 3 s). */
  killGraceMs?: number;
  pollMs?: number;
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}${sep}`);

/**
 * Stops every process of a run (TERM → KILL) and verifies none is left. With `worktree`, also the
 * runner user's processes re-parented to init that work in it. Resolves with the pids it signalled
 * (empty when nothing was running); throws `HarnessStillRunning` when something is left, or when
 * `ps` can't be read to tell.
 */
export async function stopHarness(
  procs: Procs,
  settingsPath: string,
  options: StopOptions & { worktree?: string } = {},
): Promise<number[]> {
  const termGraceMs = options.termGraceMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 3_000;
  const pollMs = options.pollMs ?? 100;
  const list = async () => {
    try {
      return ours(procs, await procs.list());
    } catch (err) {
      // Once more: a slow `ps` under load is not proof of anything.
      return procs.list().then(
        (all) => ours(procs, all),
        () => {
          throw new HarnessStillRunning(
            settingsPath,
            [],
            `can't tell whether the job's Claude stopped: ${err instanceof Error ? err.message : err}`,
          );
        },
      );
    }
  };
  /** Re-parented processes working in the job's worktree (best effort). */
  const strays = async (all: Proc[]): Promise<Proc[]> => {
    const worktree = options.worktree;
    if (!worktree || !procs.cwds) return [];
    const orphans = all.filter((p) => p.ppid === 1 && p.pid !== process.pid);
    const cwds = await procs.cwds(orphans.map((p) => p.pid)).catch(() => new Map<number, string>());
    return orphans.filter((p) => {
      const cwd = cwds.get(p.pid);
      return cwd !== undefined && under(cwd, worktree);
    });
  };
  const all = await list();
  const roots = all.filter((p) => runsWithSettings(p.command, settingsPath));
  const stray = await strays(all);
  if (roots.length === 0 && stray.length === 0) return [];
  const own = await procs.ownGroup();
  const safe = (pgid: number) => pgid > 1 && pgid !== own && pgid !== process.pid;
  // The roots' groups (a root leads its own: the pane, or a detached stream session), and every
  // descendant that left the group (a tool that called setsid), found before anything dies and
  // is re-parented.
  const groups = new Set(roots.filter((p) => p.pgid === p.pid && safe(p.pgid)).map((p) => p.pgid));
  const singles = new Set<number>(stray.map((p) => p.pid));
  const children = new Map<number, Proc[]>();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const walk = [...roots, ...stray];
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
        // Gone already, or not ours.
      }
    }
    for (const pid of singles) {
      try {
        procs.kill(pid, sig);
      } catch {
        // Gone already, or not ours.
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
  const after = await list();
  const left = [
    ...after.filter((p) => runsWithSettings(p.command, settingsPath)),
    ...after.filter((p) => singles.has(p.pid) && !gone(procs, p.pid)),
  ];
  if (left.length > 0) {
    throw new HarnessStillRunning(settingsPath, [...new Set(left.map((p) => p.pid))]);
  }
  return [...new Set([...groups, ...singles])];
}
