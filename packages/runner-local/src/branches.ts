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

/**
 * Deletes a run branch (and its marker) unless a worktree has it checked out. Returns the path that
 * has it when it was left alone, else null.
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
    const r = await exec("git", ["branch", "-D", branch], { cwd: checkout });
    if (r.code !== 0)
      throw new Error(`git branch -D ${branch} exited ${r.code}: ${r.stderr.trim()}`);
  }
  await exec("git", ["update-ref", "-d", marker(branch)], { cwd: checkout });
  return null;
}

/**
 * The marked run branches no worktree has checked out (left by crashed jobs), and, unless
 * `dryRun`, deletes them. Returns their names.
 */
export async function sweepRunBranches(
  checkout: string,
  options: { exec?: Exec; dryRun?: boolean } = {},
): Promise<string[]> {
  const exec = options.exec ?? nodeExec;
  const marked = await markedRunBranches(checkout, exec);
  if (marked.length === 0) return [];
  const out = await checkedOutBranches(checkout, exec);
  const stale = marked.filter((b) => !out.has(b));
  if (!options.dryRun) {
    for (const b of stale) await deleteRunBranch(checkout, b, exec).catch(() => {});
  }
  return stale;
}
