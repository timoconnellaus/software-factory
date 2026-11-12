// After a host crash, and for `sf-runner doctor`: the job sessions (`sf-*` on the factory's tmux
// socket) and job worktrees (`<worktreesDir>/sf-*`) whose job the host no longer runs. Reaping
// kills those sessions, removes those worktrees from their checkouts (and their local run branches,
// run dirs and attachments). The cloud fails those runs on its own once their leases lapse
// (ADR 0035). Nothing outside the factory's socket and worktrees dir is ever touched.
import { readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { removeRunDir } from "@software-factory/harness-claude";
import { isRunBranch } from "./adapter.ts";
import { type CheckoutSearch, duplicateCheckouts, isUnder, scanCheckouts } from "./checkouts.ts";
import { type Exec, nodeExec } from "./exec.ts";
import { jobIdOfSession, type TmuxOptions, tmuxCli } from "./tmux.ts";

export interface LocalHostDirs {
  worktreesDir: string;
  runsDir: string;
  /** Default: `attachments` next to `runsDir`. */
  attachmentsDir?: string;
  exec?: Exec;
  tmux?: Omit<TmuxOptions, "exec">;
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
    const jobId = entry.isDirectory() ? jobIdOfSession(entry.name) : null;
    if (!jobId) continue;
    const path = join(root, entry.name);
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
    if (w.branch && isRunBranch(w.branch)) {
      await exec("git", ["branch", "-D", w.branch], { cwd: w.checkout });
    }
  }
  await removeRunDir(join(dirs.runsDir, w.jobId));
  await removeRunDir(
    join(dirs.attachmentsDir ?? join(dirname(dirs.runsDir), "attachments"), w.jobId),
  );
}

/**
 * Kills `sf-*` sessions and removes `sf-*` worktrees for jobs not in `running`. Returns the job ids
 * it cleaned up.
 */
export async function reapOrphans(dirs: LocalHostDirs, running: Set<string>): Promise<string[]> {
  const tmux = tmuxCli({ ...dirs.tmux, ...(dirs.exec ? { exec: dirs.exec } : {}) });
  const reaped = new Set<string>();
  for (const s of await tmux.jobSessions().catch(() => [])) {
    const jobId = jobIdOfSession(s.name);
    if (!jobId || running.has(jobId)) continue;
    await tmux.kill(s.name).catch(() => {});
    reaped.add(jobId);
  }
  for (const w of await jobWorktrees(dirs)) {
    if (running.has(w.jobId)) continue;
    await removeJobWorktree(dirs, w).catch(() => {});
    reaped.add(w.jobId);
  }
  return [...reaped];
}

export interface Finding {
  kind: "duplicate-checkouts" | "orphan-session" | "orphan-worktree";
  message: string;
  /** Whether `--fix` can repair it without touching the owner's own checkouts. */
  fixable: boolean;
}

/**
 * What `sf-runner doctor` checks: one checkout per remote under the `checkouts` dirs, and no job
 * session or worktree without a live job.
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
  for (const w of await jobWorktrees(options)) {
    if (options.live.has(w.jobId)) continue;
    findings.push({
      kind: "orphan-worktree",
      message: `job worktree ${w.path}${w.checkout ? ` (of ${w.checkout})` : ""} has no running job`,
      fixable: true,
    });
  }
  return findings;
}
