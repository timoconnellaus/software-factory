// The local run branches runner-local creates in a checkout (spec 43, ADR 0551). A job's branch is
// the run's own (ADR 0035: one branch per run), but its name isn't always `factory/…`: an attached
// PR's runs use `<pr-branch>-run-<k>`. So the adapter doesn't guess from the name: when it creates
// a job's branch it records a marker ref, `refs/software-factory/run-branches/<branch>`, in the
// checkout, and it only ever deletes a branch it marked, or the job's own branch, and only when no
// worktree has it checked out. An owner's branch is never marked, so never swept.
import { type Exec, nodeExec } from "./exec.ts";

export const RUN_BRANCH_MARKERS = "refs/software-factory/run-branches/";

const marker = (branch: string) => `${RUN_BRANCH_MARKERS}${branch}`;

/** The branches checked out in any worktree of the checkout (the main one included). */
export async function checkedOutBranches(checkout: string, exec: Exec = nodeExec) {
  const r = await exec("git", ["worktree", "list", "--porcelain"], { cwd: checkout });
  if (r.code !== 0) throw new Error(`git worktree list exited ${r.code}: ${r.stderr.trim()}`);
  const out = new Map<string, string>();
  let path = "";
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    const m = /^branch refs\/heads\/(.+)$/.exec(line);
    if (m?.[1]) out.set(m[1], path);
  }
  return out;
}

export async function branchExists(checkout: string, branch: string, exec: Exec = nodeExec) {
  const r = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: checkout,
  });
  return r.code === 0;
}

/** Records that the factory created `branch` in this checkout. */
export async function markRunBranch(checkout: string, branch: string, exec: Exec = nodeExec) {
  const r = await exec("git", ["update-ref", marker(branch), `refs/heads/${branch}`], {
    cwd: checkout,
  });
  if (r.code !== 0) throw new Error(`git update-ref exited ${r.code}: ${r.stderr.trim()}`);
}

export async function isMarkedRunBranch(checkout: string, branch: string, exec: Exec = nodeExec) {
  const r = await exec("git", ["rev-parse", "--verify", "--quiet", marker(branch)], {
    cwd: checkout,
  });
  return r.code === 0;
}

/** The branches this checkout has markers for. */
export async function markedRunBranches(checkout: string, exec: Exec = nodeExec) {
  const r = await exec("git", ["for-each-ref", "--format=%(refname)", RUN_BRANCH_MARKERS], {
    cwd: checkout,
  });
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith(RUN_BRANCH_MARKERS))
    .map((l) => l.slice(RUN_BRANCH_MARKERS.length));
}

const revParse = async (checkout: string, ref: string, exec: Exec) => {
  const r = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: checkout,
  });
  return r.code === 0 ? r.stdout.trim() : null;
};

/**
 * Whether deleting a branch loses nothing: its tip is still where the factory marked it, or is in
 * the remote's copy of the run branch. Anything else (the owner committed on it) is kept.
 */
export async function runBranchDisposable(
  checkout: string,
  branch: string,
  exec: Exec = nodeExec,
): Promise<boolean> {
  const tip = await revParse(checkout, `refs/heads/${branch}`, exec);
  if (!tip) return true;
  if ((await revParse(checkout, marker(branch), exec)) === tip) return true;
  const remote = await revParse(checkout, `refs/remotes/origin/${branch}`, exec);
  if (!remote) return false;
  const r = await exec("git", ["merge-base", "--is-ancestor", tip, remote], { cwd: checkout });
  return r.code === 0;
}

/**
 * Deletes a run branch (and its marker) unless a worktree has it checked out. Returns the path that
 * has it when it was left alone, else null. Only for a branch this job just made, or one
 * `runBranchDisposable` says loses nothing.
 */
export async function deleteRunBranch(
  checkout: string,
  branch: string,
  exec: Exec = nodeExec,
): Promise<string | null> {
  const out = await checkedOutBranches(checkout, exec);
  const at = out.get(branch);
  if (at) return at;
  if (await branchExists(checkout, branch, exec)) {
    const r = await exec("git", ["branch", "-D", "--", branch], { cwd: checkout });
    if (r.code !== 0)
      throw new Error(`git branch -D ${branch} exited ${r.code}: ${r.stderr.trim()}`);
  }
  await exec("git", ["update-ref", "-d", marker(branch)], { cwd: checkout });
  return null;
}

/**
 * Moves a branch that is in the way but can't be deleted without losing commits out of the way
 * (`<branch>-kept-<time>`), so the new run can take its name. Returns the new name.
 */
export async function moveAsideRunBranch(
  checkout: string,
  branch: string,
  exec: Exec = nodeExec,
): Promise<string> {
  const kept = `${branch}-kept-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  const r = await exec("git", ["branch", "-m", "--", branch, kept], { cwd: checkout });
  if (r.code !== 0) throw new Error(`git branch -m ${branch} exited ${r.code}: ${r.stderr.trim()}`);
  await exec("git", ["update-ref", "-d", marker(branch)], { cwd: checkout });
  return kept;
}

export interface SweptBranch {
  branch: string;
  /** False: it has commits the factory can't account for, so it is left for its owner. */
  disposable: boolean;
}

/**
 * The marked run branches no worktree has checked out (left by crashed jobs), and, unless
 * `dryRun`, deletes the ones that lose nothing (`runBranchDisposable`).
 */
export async function sweepRunBranches(
  checkout: string,
  options: { exec?: Exec; dryRun?: boolean } = {},
): Promise<SweptBranch[]> {
  const exec = options.exec ?? nodeExec;
  const marked = await markedRunBranches(checkout, exec);
  if (marked.length === 0) return [];
  const out = await checkedOutBranches(checkout, exec);
  const found: SweptBranch[] = [];
  for (const branch of marked.filter((b) => !out.has(b))) {
    const disposable = await runBranchDisposable(checkout, branch, exec);
    found.push({ branch, disposable });
    if (disposable && !options.dryRun) {
      await deleteRunBranch(checkout, branch, exec).catch(() => {});
    }
  }
  return found;
}
