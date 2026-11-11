// Git helpers every adapter that works on a local checkout shares: the diff artifact is the same
// whether Orca, a plain worktree or a dev box made the checkout.

import type { Artifact } from "../contract/types.ts";
import { type Exec, run } from "./exec.ts";

export async function headSha(exec: Exec, cwd: string): Promise<string> {
  return (await run(exec, "git", ["rev-parse", "HEAD"], { cwd })).trim();
}

/**
 * Everything the session changed since `baseSha`: commits it made, staged and unstaged edits and
 * new files. Stages with `git add -A` (the workspace is the job's own, so its index is ours).
 */
export async function collectDiff(
  exec: Exec,
  cwd: string,
  baseSha: string,
  branch: string,
): Promise<Extract<Artifact, { kind: "diff" }>> {
  await run(exec, "git", ["add", "-A"], { cwd });
  const patch = await run(exec, "git", ["diff", "--cached", "--binary", baseSha], { cwd });
  const numstat = await run(exec, "git", ["diff", "--cached", "--numstat", baseSha], { cwd });
  let insertions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, removed] = line.split("\t");
    files++;
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return {
    kind: "diff",
    baseSha,
    headSha: await headSha(exec, cwd),
    branch,
    patch,
    stats: { files, insertions, deletions },
  };
}

/** Deletes a local branch if it exists. */
export async function deleteBranch(exec: Exec, repoPath: string, branch: string): Promise<void> {
  const exists = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repoPath,
  });
  if (exists.code === 0) await run(exec, "git", ["branch", "-D", branch], { cwd: repoPath });
}
