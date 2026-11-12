// What a sprite's session leaves, brought back into the host's job repo (ADR 0480). The agent's
// sprite holds a copy of the job repo; the host's own copy is the one it pushes from, and the agent
// never touches it. When the session ends the host runs the fixed `RESULT` script in the sprite: it
// snapshots the whole working tree as a commit on top of the agent's HEAD and prints a bundle of
// everything new. The host fetches that bundle into its job repo with its own git (no hooks, no
// config from the sprite: a bundle is only objects and refs), puts the branch on the agent's HEAD
// and the working tree on the snapshot, and then runs its unchanged steps: the merge check, the
// leftovers commit, the credential scan, the push with the job token, the diff. Nothing the sprite
// sends is ever unpacked as files by anything but git's own checkout.
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
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

/** The script's first line: the header, checked. */
export function parseResultHeader(line: string): ResultHeader {
  const raw = JSON.parse(line) as Partial<ResultHeader>;
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
  return header;
}

/** The most a result (the header and the bundle) may be. */
export const MAX_RESULT_BYTES = 2 * 1024 ** 3;

/**
 * Runs the result script in the sandbox, its output streamed to `outFile` (never held in memory,
 * capped at `MAX_RESULT_BYTES`), then splits it: the header, and the bundle into `bundleFile`.
 */
export async function fetchResult(
  api: SandboxApi,
  sandbox: string,
  paths: { work: string; gitDir: string; tmp: string; base: string },
  files: { outFile: string; bundleFile: string; maxBytes?: number },
): Promise<ResultHeader> {
  try {
    const r = await api.exec(
      sandbox,
      scriptArgv(RESULT, [paths.work, paths.gitDir, paths.tmp, paths.base]),
      {
        timeoutMs: 10 * 60_000,
        stdoutFile: files.outFile,
        maxStdout: files.maxBytes ?? MAX_RESULT_BYTES,
      },
    );
    if (r.code !== 0) {
      throw new Error(
        `the result script exited ${r.code}: ${r.stderr.toString().trim().slice(-500)}`,
      );
    }
    const fd = await open(files.outFile, "r");
    let head: Buffer;
    try {
      head = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(head, 0, head.length, 0);
      head = head.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
    const nl = head.indexOf(0x0a);
    if (nl < 0) throw new Error("the sprite's result has no header");
    const header = parseResultHeader(head.subarray(0, nl).toString("utf8"));
    await pipeline(
      createReadStream(files.outFile, { start: nl + 1 }),
      createWriteStream(files.bundleFile, { mode: 0o600 }),
    );
    return header;
  } finally {
    await rm(files.outFile, { force: true });
  }
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
  /** The bundle (`fetchResult`'s), outside the working tree; removed afterwards. */
  bundleFile: string;
}): Promise<string[]> {
  const { exec, work, header } = input;
  const env = hostGitEnv();
  const git = (args: string[]) =>
    run(exec, "git", [...SAFE_GIT, ...args], { cwd: work, env, timeoutMs: 10 * 60_000 });
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
