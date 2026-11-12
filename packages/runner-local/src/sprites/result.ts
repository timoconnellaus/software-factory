// What a sprite's session leaves, brought back into the host's job repo (ADR 0460). The agent's
// sprite holds a copy of the job repo; the host's own copy is the one it pushes from, and the agent
// never touches it. When the session ends the host runs the fixed `RESULT` script in the sprite: it
// snapshots the whole working tree as a commit on top of the agent's HEAD and prints a bundle of
// everything new. The host fetches that bundle into its job repo with its own git (no hooks, no
// config from the sprite: a bundle is only objects and refs), puts the branch on the agent's HEAD
// and the working tree on the snapshot, and then runs its unchanged steps: the merge check, the
// leftovers commit, the credential scan, the push with the job token, the diff. Nothing the sprite
// sends is ever unpacked as files by anything but git's own checkout.
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostGitEnv, SAFE_GIT } from "../container/job-repo.ts";
import { type Exec, run } from "../exec.ts";
import type { SandboxApi } from "./api.ts";
import { RESULT, scriptArgv } from "./scripts.ts";

export interface ResultHeader {
  /** The agent's HEAD in the sprite. */
  head: string;
  /** A commit on `head` whose tree is the sprite's whole working tree. */
  snapshot: string;
  /** Index entries left unmerged. */
  unmerged: number;
  /** The sprite's MERGE_HEAD, empty when no merge is in progress. */
  mergeHead: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Where the snapshot is fetched to in the host's job repo, for the length of the import. */
export const SNAPSHOT_REF = "refs/software-factory/sprite-snapshot";

/** Splits the script's output: the JSON line, then the bundle. */
export function parseResult(out: Buffer): { header: ResultHeader; bundle: Buffer } {
  const nl = out.indexOf(0x0a);
  if (nl < 0) throw new Error("the sprite's result has no header");
  const raw = JSON.parse(out.subarray(0, nl).toString("utf8")) as Partial<ResultHeader>;
  const header: ResultHeader = {
    head: String(raw.head ?? ""),
    snapshot: String(raw.snapshot ?? ""),
    unmerged: Number(raw.unmerged ?? 0),
    mergeHead: String(raw.mergeHead ?? ""),
  };
  if (!SHA.test(header.head) || !SHA.test(header.snapshot)) {
    throw new Error("the sprite's result names no commit");
  }
  if (header.mergeHead && !SHA.test(header.mergeHead)) header.mergeHead = "";
  if (!Number.isInteger(header.unmerged) || header.unmerged < 0) header.unmerged = 0;
  return { header, bundle: out.subarray(nl + 1) };
}

/** Runs the result script in the sandbox. */
export async function fetchResult(
  api: SandboxApi,
  sandbox: string,
  paths: { work: string; gitDir: string; tmp: string; base: string },
): Promise<{ header: ResultHeader; bundle: Buffer }> {
  const r = await api.exec(
    sandbox,
    scriptArgv(RESULT, [paths.work, paths.gitDir, paths.tmp, paths.base]),
    { timeoutMs: 10 * 60_000 },
  );
  if (r.code !== 0) {
    throw new Error(
      `the result script exited ${r.code}: ${r.stderr.toString().trim().slice(-500)}`,
    );
  }
  return parseResult(r.stdout);
}

/**
 * Brings the result into the host's job repo: the run branch on the agent's HEAD, the working tree
 * equal to the sprite's, the index at HEAD (so the leftovers are uncommitted changes, as on a
 * worktree). Returns problems that fail the job (nothing is imported then).
 */
export async function importResult(input: {
  exec: Exec;
  work: string;
  gitDir: string;
  branch: string;
  header: ResultHeader;
  bundle: Buffer;
  /** Where the bundle is written for the fetch (outside the working tree). */
  bundleFile: string;
}): Promise<string[]> {
  const { exec, work, header } = input;
  const env = hostGitEnv();
  const git = (args: string[]) =>
    run(exec, "git", [...SAFE_GIT, ...args], { cwd: work, env, timeoutMs: 10 * 60_000 });
  await writeFile(input.bundleFile, input.bundle, { mode: 0o600 });
  try {
    await git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      input.bundleFile,
      `+refs/software-factory/snapshot:${SNAPSHOT_REF}`,
    ]);
    const snapshot = (await git(["rev-parse", "--verify", `${SNAPSHOT_REF}^{commit}`])).trim();
    if (snapshot !== header.snapshot) {
      return [
        `the sprite's bundle holds ${snapshot.slice(0, 12)}, not ${header.snapshot.slice(0, 12)}`,
      ];
    }
    const parent = (await git(["rev-parse", "--verify", `${snapshot}^1`])).trim();
    if (parent !== header.head) return ["the sprite's snapshot isn't on its HEAD"];
    // The branch on the agent's HEAD, then the working tree on the snapshot and the index back on
    // HEAD: what the agent didn't commit is an uncommitted change here too.
    await git(["symbolic-ref", "HEAD", `refs/heads/${input.branch}`]);
    await git(["update-ref", `refs/heads/${input.branch}`, header.head]);
    await git(["read-tree", "-u", "--reset", snapshot]);
    await git(["reset", "--quiet"]);
  } finally {
    await exec("git", [...SAFE_GIT, "update-ref", "-d", SNAPSHOT_REF], { cwd: work, env });
    await rm(input.bundleFile, { force: true });
  }
  // A merge the host started (ADR 0320) is still in progress only if it is in the sprite too.
  const hostMerge = await exec("git", [...SAFE_GIT, "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    cwd: work,
    env,
  });
  if (hostMerge.code === 0 && hostMerge.stdout.trim() !== header.mergeHead) {
    for (const f of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"]) {
      await rm(join(input.gitDir, f), { force: true });
    }
  }
  if (header.unmerged > 0) {
    return [`the session left ${header.unmerged} unmerged index entries (an unresolved merge)`];
  }
  return [];
}
