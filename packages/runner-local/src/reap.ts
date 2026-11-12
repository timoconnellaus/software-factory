// After a host crash, and for `sf-runner doctor`: the job sessions (`sf-*` on the factory's tmux
// socket), job processes (a Claude whose command line names `<runsDir>/<jobId>/claude-settings.json`,
// ADR 0550), job worktrees (`<worktreesDir>/sf-*`) and marked run branches (ADR 0551) whose job the
// host no longer runs. Reaping kills those sessions, stops those processes (TERM, then KILL), removes
// those worktrees from their checkouts (and their local run branches, run dirs and attachments) and
// deletes those branches. The cloud fails those runs on its own once their leases lapse (ADR 0035).
// Nothing outside the factory's socket, its runs and worktrees dirs and its marked branches is ever
// touched.
import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { RUN_SETTINGS_FILE, removeRunDir } from "@software-factory/harness-claude";
import { isRunBranch, WORKTREE_JOB_FILE } from "./adapter.ts";
import { deleteRunBranch, isMarkedRunBranch, sweepRunBranches } from "./branches.ts";
import { type CheckoutSearch, duplicateCheckouts, isUnder, scanCheckouts } from "./checkouts.ts";
import { type Exec, nodeExec } from "./exec.ts";
import {
  HarnessStillRunning,
  hostProcs,
  type Procs,
  type StopOptions,
  stopHarness,
} from "./procs.ts";
import { jobIdOfSession, type TmuxOptions, tmuxCli } from "./tmux.ts";

export interface LocalHostDirs {
  worktreesDir: string;
  runsDir: string;
  /** Default: `attachments` next to `runsDir`. */
  attachmentsDir?: string;
  exec?: Exec;
  tmux?: Omit<TmuxOptions, "exec">;
  /** How processes are read and signalled (default `ps` and `kill`). */
  procs?: Procs;
  stop?: StopOptions;
  /**
   * The checkouts whose marked run branches are swept (`runner.json` `checkouts`), besides the
   * ones the job worktrees hang off.
   */
  checkouts?: CheckoutSearch;
}

export interface JobWorktree {
  jobId: string;
  path: string;
  /** The checkout it hangs off, or null when its git link is broken. */
  checkout: string | null;
  branch: string | null;
}

/** The job worktrees under the worktrees dir. */
export async function jobWorktrees(dirs: LocalHostDirs): Promise<JobWorktree[]> {
  const exec = dirs.exec ?? nodeExec;
  const root = await realpath(dirs.worktreesDir).catch(() => null);
  if (!root) return [];
  const out: JobWorktree[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const named = entry.isDirectory() ? jobIdOfSession(entry.name) : null;
    if (!named) continue;
    const path = join(root, entry.name);
    // The job a worktree belongs to is in its private git dir (a planning worktree is named after
    // its session, ADR 0350); worktrees from before the marker are named after their job.
    const marker = await readFile(join(path, ".git"), "utf8")
      .then((t) => t.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim())
      .then((gitDir) =>
        gitDir ? readFile(join(gitDir, WORKTREE_JOB_FILE), "utf8").then((t) => t.trim()) : "",
      )
      .catch(() => "");
    const jobId = marker || named;
    // A linked worktree has a `.git` file; without one git would find whatever repo is above.
    const linked = await readFile(join(path, ".git"), "utf8").then(
      (t) => t.startsWith("gitdir:"),
      () => false,
    );
    if (!linked) {
      out.push({ jobId, path, checkout: null, branch: null });
      continue;
    }
    const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: path,
    });
    const commonDir = common.code === 0 ? common.stdout.trim() : "";
    // `<checkout>/.git` for a normal clone; a bare repo is its own git dir.
    const checkout = commonDir
      ? basename(commonDir) === ".git"
        ? dirname(commonDir)
        : commonDir
      : null;
    const head = await exec("git", ["branch", "--show-current"], { cwd: path });
    out.push({
      jobId,
      path,
      checkout,
      branch: head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null,
    });
  }
  return out;
}

/** Removes one job worktree, its local run branch, run dir and attachments. */
async function removeJobWorktree(dirs: LocalHostDirs, w: JobWorktree): Promise<void> {
  const exec = dirs.exec ?? nodeExec;
  const root = await realpath(dirs.worktreesDir).catch(() => dirs.worktreesDir);
  if (!isUnder(w.path, root)) return;
  if (w.checkout) {
    await exec("git", ["worktree", "remove", "--force", "--force", w.path], { cwd: w.checkout });
  }
  await rm(w.path, { recursive: true, force: true });
  if (w.checkout) {
    await exec("git", ["worktree", "prune"], { cwd: w.checkout });
    // Only a branch the factory marked as its own (ADR 0551), or a factory run branch.
    if (
      w.branch &&
      (isRunBranch(w.branch) || (await isMarkedRunBranch(w.checkout, w.branch, exec)))
    ) {
      await deleteRunBranch(w.checkout, w.branch, exec);
    }
  }
  await removeRunDir(join(dirs.runsDir, w.jobId));
  await removeRunDir(
    join(dirs.attachmentsDir ?? join(dirname(dirs.runsDir), "attachments"), w.jobId),
  );
}

export interface JobProcess {
  jobId: string;
  pid: number;
  settingsPath: string;
}

/** The host's processes running a job's harness: their command line names its settings path. */
export async function jobProcesses(dirs: LocalHostDirs): Promise<JobProcess[]> {
  const procs = dirs.procs ?? hostProcs(dirs.exec ?? nodeExec);
  const prefix = dirs.runsDir.endsWith(sep) ? dirs.runsDir : `${dirs.runsDir}${sep}`;
  const out: JobProcess[] = [];
  for (const p of await procs.list()) {
    let at = p.command.indexOf(prefix);
    while (at >= 0) {
      const rest = p.command.slice(at + prefix.length);
      const m = /^([^/\s]+)\/([^\s]+)/.exec(rest);
      if (m?.[1] && m[2] === RUN_SETTINGS_FILE) {
        out.push({
          jobId: m[1],
          pid: p.pid,
          settingsPath: `${prefix}${m[1]}/${RUN_SETTINGS_FILE}`,
        });
        break;
      }
      at = p.command.indexOf(prefix, at + 1);
    }
  }
  return out;
}

/** The checkouts to sweep for marked run branches. */
async function sweepTargets(dirs: LocalHostDirs, worktrees: JobWorktree[]): Promise<string[]> {
  const out = new Set(worktrees.map((w) => w.checkout).filter((c): c is string => !!c));
  if (dirs.checkouts) {
    for (const c of await scanCheckouts(dirs.checkouts).catch(() => [])) out.add(c.path);
  }
  return [...out];
}

/**
 * Kills `sf-*` sessions, stops job processes, removes `sf-*` worktrees and sweeps marked run
 * branches for jobs not in `running`. Returns the job ids it cleaned up. Throws
 * `HarnessStillRunning` (after cleaning up everything else) when a job's processes survived TERM
 * and KILL.
 */
export async function reapOrphans(dirs: LocalHostDirs, running: Set<string>): Promise<string[]> {
  const exec = dirs.exec ?? nodeExec;
  const tmux = tmuxCli({ ...dirs.tmux, exec });
  const procs = dirs.procs ?? hostProcs(exec);
  const reaped = new Set<string>();
  for (const s of await tmux.jobSessions().catch(() => [])) {
    const jobId = jobIdOfSession(s.name);
    if (!jobId || running.has(jobId)) continue;
    await tmux.kill(s.name).catch(() => {});
    reaped.add(jobId);
  }
  // Whether or not tmux answered: a Claude left running is found by its settings path.
  const survived: string[] = [];
  const orphans = await jobProcesses({ ...dirs, procs }).catch(() => [] as JobProcess[]);
  for (const settingsPath of new Set(
    orphans.filter((p) => !running.has(p.jobId)).map((p) => p.settingsPath),
  )) {
    await stopHarness(procs, settingsPath, dirs.stop).catch((err) => {
      survived.push(err instanceof Error ? err.message : String(err));
    });
    reaped.add(orphans.find((p) => p.settingsPath === settingsPath)?.jobId ?? settingsPath);
  }
  const worktrees = await jobWorktrees(dirs);
  for (const w of worktrees) {
    if (running.has(w.jobId)) continue;
    await removeJobWorktree(dirs, w).catch(() => {});
    reaped.add(w.jobId);
  }
  for (const checkout of await sweepTargets(dirs, worktrees)) {
    await sweepRunBranches(checkout, { exec }).catch(() => []);
  }
  if (survived.length) {
    throw new HarnessStillRunning(
      "",
      [],
      `reaped ${[...reaped].join(", ")}; ${survived.join("; ")}`,
    );
  }
  return [...reaped];
}

export interface Finding {
  kind:
    | "duplicate-checkouts"
    | "orphan-session"
    | "orphan-worktree"
    | "orphan-process"
    | "orphan-branch";
  message: string;
  /** Whether `--fix` can repair it without touching the owner's own checkouts. */
  fixable: boolean;
}

/**
 * What `sf-runner doctor` checks: one checkout per remote under the `checkouts` dirs, and no job
 * session, process, worktree or marked run branch without a live job.
 */
export async function diagnose(
  options: LocalHostDirs & { checkouts: CheckoutSearch; live: Set<string> },
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const [key, list] of duplicateCheckouts(await scanCheckouts(options.checkouts))) {
    findings.push({
      kind: "duplicate-checkouts",
      message: `${key} has ${list.length} checkouts: ${list.map((c) => c.path).join(", ")} (jobs use the first)`,
      fixable: false,
    });
  }
  const tmux = tmuxCli({ ...options.tmux, ...(options.exec ? { exec: options.exec } : {}) });
  for (const s of await tmux.jobSessions().catch(() => [])) {
    const jobId = jobIdOfSession(s.name);
    if (!jobId || options.live.has(jobId)) continue;
    findings.push({
      kind: "orphan-session",
      message: `tmux session ${s.name} has no running job`,
      fixable: true,
    });
  }
  for (const p of await jobProcesses(options).catch(() => [] as JobProcess[])) {
    if (options.live.has(p.jobId)) continue;
    findings.push({
      kind: "orphan-process",
      message: `process ${p.pid} is job ${p.jobId}'s Claude, and the host doesn't run that job`,
      fixable: true,
    });
  }
  const worktrees = await jobWorktrees(options);
  for (const w of worktrees) {
    if (options.live.has(w.jobId)) continue;
    findings.push({
      kind: "orphan-worktree",
      message: `job worktree ${w.path}${w.checkout ? ` (of ${w.checkout})` : ""} has no running job`,
      fixable: true,
    });
  }
  for (const checkout of await sweepTargets(options, worktrees)) {
    for (const b of await sweepRunBranches(checkout, {
      dryRun: true,
      ...(options.exec ? { exec: options.exec } : {}),
    }).catch(() => [] as string[])) {
      findings.push({
        kind: "orphan-branch",
        message: `run branch ${b} in ${checkout} was left by a job that no worktree runs`,
        fixable: true,
      });
    }
  }
  return findings;
}
