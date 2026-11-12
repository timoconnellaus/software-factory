// A container job's own repo (ADR 0430 §3). A linked worktree's `.git` points at the checkout's
// common git dir: every branch, its config and hooks. Mounting that into the container would hand
// the agent all of it, and a reference clone still shares every object. So each job gets a new repo:
// a working tree and a separate git dir, holding only the start point's history and the default
// branch (for the host's merge, ADR 0320), fetched from the checkout through a temporary ref in the
// factory's own namespace. The host's git steps (merge, leftovers, push, diff) then run on it as they
// ran on a worktree.
//
// The agent can write into the git dir (objects, refs, the index), so after the session, before the
// host runs any git there, `checkJobGitDir` removes anything that would point git elsewhere or run
// code (a `commondir`, alternates, hooks, a changed config, symlinks), and `scanForSecrets` looks for
// the model credential in everything the host would push.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { PRIVATE_WORKTREE_FILES } from "@software-factory/harness-claude";
import { type Exec, run } from "../exec.ts";

/** Where the runner host keeps the item branches it fetched (runner-host `FETCH_NAMESPACE`). */
export const HOST_FETCH_NAMESPACE = "refs/software-factory/heads";
/** The temporary ref a job's start point is fetched through, in the checkout. */
export const JOB_REF_NAMESPACE = "refs/software-factory/jobs";

/** The host's git: no system or global config, no hooks, never a prompt. */
export function hostGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !/^GIT_|TOKEN|SECRET|PASSWORD|CREDENTIAL|^SSH_/i.test(k)) out[k] = v;
  }
  return {
    ...out,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Flags on every host git call into a job repo: nothing in it may run code. */
export const SAFE_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.file.allow=always",
];

/** The job repo's own config: what the host writes, and what the check restores. */
export function jobRepoConfig(): string {
  return [
    "# Written by the software factory runner: a container job's repo (ADR 0430). Read-only to",
    "# the agent; the runner checks it before the host runs git here.",
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "\tfsmonitor = false",
    "[gc]",
    "\tauto = 0",
    "[maintenance]",
    "\tauto = false",
    "[receive]",
    "\tdenyCurrentBranch = refuse",
    "",
  ].join("\n");
}

export interface JobRepo {
  work: string;
  gitDir: string;
  baseSha: string;
  /** The working tree's `.git` file, exactly. */
  dotGit: string;
  /** sha256 of the git dir's config. */
  configHash: string;
}

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/**
 * Makes the job's repo: `git init --separate-git-dir`, then a fetch from `checkout` of the start
 * point (as the run branch) and of the host's fetched item and default branches, nothing else.
 * The checkout gains one temporary ref for the fetch, removed before this returns.
 */
export async function createJobRepo(input: {
  exec: Exec;
  checkout: string;
  work: string;
  gitDir: string;
  jobId: string;
  branch: string;
  /** A ref or SHA in the checkout. */
  start: string;
  /** More refs to copy from the checkout, when it has them (same name in the job repo). */
  refs?: string[];
}): Promise<JobRepo> {
  const { exec, checkout, work, gitDir } = input;
  const env = hostGitEnv();
  const git = (cwd: string, args: string[]) =>
    run(exec, "git", [...SAFE_GIT, ...args], { cwd, env, timeoutMs: 10 * 60_000 });
  await mkdir(work, { recursive: true });
  await git(work, [
    "init",
    "--quiet",
    `--initial-branch=${input.branch}`,
    "--separate-git-dir",
    gitDir,
    work,
  ]);
  // No sample hooks, our own config, the harness's private files kept out of git.
  await rm(join(gitDir, "hooks"), { recursive: true, force: true });
  await mkdir(join(gitDir, "hooks"));
  await mkdir(join(gitDir, "info"), { recursive: true });
  await mkdir(join(gitDir, "objects", "info"), { recursive: true });
  await writeFile(join(gitDir, "config"), jobRepoConfig());
  await writeFile(
    join(gitDir, "info", "exclude"),
    `${PRIVATE_WORKTREE_FILES.map((f) => `/${f}`).join("\n")}\n`,
  );

  const startSha = (
    await git(checkout, ["rev-parse", "--verify", `${input.start}^{commit}`])
  ).trim();
  const temp = `${JOB_REF_NAMESPACE}/${input.jobId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  await git(checkout, ["update-ref", temp, startSha]);
  try {
    const extra: string[] = [];
    for (const ref of [...new Set(input.refs ?? [])]) {
      const has = await exec("git", [...SAFE_GIT, "rev-parse", "--verify", "--quiet", ref], {
        cwd: checkout,
        env,
      });
      if (has.code === 0) extra.push(`+${ref}:${ref}`);
    }
    await git(work, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--update-head-ok",
      checkout,
      `+${temp}:refs/heads/${input.branch}`,
      ...extra,
    ]);
  } finally {
    await exec("git", [...SAFE_GIT, "update-ref", "-d", temp], { cwd: checkout, env });
  }
  await git(work, ["reset", "--quiet", "--hard", `refs/heads/${input.branch}`]);
  const baseSha = (await git(work, ["rev-parse", "HEAD"])).trim();
  if (baseSha !== startSha) throw new Error(`the job repo is at ${baseSha}, not ${startSha}`);
  return {
    work,
    gitDir,
    baseSha,
    dotGit: await readFile(join(work, ".git"), "utf8"),
    configHash: sha256(await readFile(join(gitDir, "config"))),
  };
}

/** Entries in a git dir that would send git to another git dir or object store. */
const REDIRECTS = ["commondir", "gitdir", "config.worktree", "worktrees", "modules"];
const ALTERNATES = ["objects/info/alternates", "objects/info/http-alternates"];

/**
 * Checks a job repo after its container has stopped, and puts it back the way the host left it:
 * the working tree's `.git` file, the config, an empty hooks dir, no redirects, no alternates, no
 * symlinks. Returns what it found (empty when the repo was untouched); any finding fails the job.
 */
export async function checkJobGitDir(
  repo: Pick<JobRepo, "work" | "gitDir" | "dotGit" | "configHash">,
): Promise<string[]> {
  const problems: string[] = [];
  const dotGitPath = join(repo.work, ".git");
  const dotGit = await lstat(dotGitPath).catch(() => null);
  if (!dotGit?.isFile() || (await readFile(dotGitPath, "utf8").catch(() => "")) !== repo.dotGit) {
    problems.push("the working tree's .git was changed");
    await rm(dotGitPath, { recursive: true, force: true });
    await writeFile(dotGitPath, repo.dotGit);
  }
  const root = await lstat(repo.gitDir).catch(() => null);
  if (!root?.isDirectory()) {
    // Nothing to repair in place: the host's git would fail on it, and release removes the dir.
    return [...problems, "the job's git dir is gone or not a directory"];
  }
  for (const name of [...REDIRECTS, ...ALTERNATES]) {
    const path = join(repo.gitDir, name);
    if (await lstat(path).catch(() => null)) {
      problems.push(`the session created ${name} in its git dir`);
      await rm(path, { recursive: true, force: true });
    }
  }
  const configPath = join(repo.gitDir, "config");
  const config = await lstat(configPath).catch(() => null);
  const configText = config?.isFile() ? await readFile(configPath).catch(() => null) : null;
  if (!configText || sha256(configText) !== repo.configHash) {
    problems.push("the git dir's config was changed");
    await rm(configPath, { recursive: true, force: true });
    await writeFile(configPath, jobRepoConfig());
  }
  const hooksPath = join(repo.gitDir, "hooks");
  const hooks = await lstat(hooksPath).catch(() => null);
  if (!hooks?.isDirectory() || (await readdir(hooksPath).catch(() => [])).length > 0) {
    problems.push("the git dir's hooks were changed");
    await rm(hooksPath, { recursive: true, force: true });
    await mkdir(hooksPath);
  }
  // A symlink would let the host's git write outside the job dir (refs into another directory).
  for (const entry of await readdir(repo.gitDir, { recursive: true, withFileTypes: true }).catch(
    () => [],
  )) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    problems.push(`the git dir holds a symlink: ${relative(repo.gitDir, path)}`);
    await unlink(path).catch(() => {});
  }
  return problems;
}

/** Streams `git cat-file --batch` over the given object ids, calling `onChunk` with the output. */
function catFileBatch(cwd: string, ids: string[], onChunk: (chunk: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE_GIT, "cat-file", "--batch"], {
      cwd,
      env: hostGitEnv(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout.on("data", onChunk);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git cat-file exited ${code}`)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(ids.length ? `${ids.join("\n")}\n` : "");
  });
}

/** A searcher over a stream of chunks for any of the needles. */
function searcher(needles: string[]) {
  const bytes = needles.filter((n) => n.length >= 8).map((n) => Buffer.from(n));
  const keep = Math.max(0, ...bytes.map((b) => b.length)) - 1;
  let tail = Buffer.alloc(0);
  let found = false;
  return {
    feed(chunk: Buffer) {
      if (found || bytes.length === 0) return;
      const buf = Buffer.concat([tail, chunk]);
      if (bytes.some((b) => buf.includes(b))) found = true;
      tail = buf.subarray(Math.max(0, buf.length - keep));
    },
    get found() {
      return found;
    },
  };
}

/**
 * Whether any secret appears in what the host would push or commit: every object new since
 * `baseSha` (commits, trees, blobs), the uncommitted changes and the untracked files. Secrets
 * shorter than 8 characters are ignored. Returns where it was found.
 */
export async function scanForSecrets(
  exec: Exec,
  work: string,
  baseSha: string,
  secrets: string[],
): Promise<string[]> {
  if (secrets.filter((s) => s.length >= 8).length === 0) return [];
  const env = hostGitEnv();
  const git = (args: string[]) =>
    exec("git", [...SAFE_GIT, ...args], { cwd: work, env, timeoutMs: 10 * 60_000 });
  const where: string[] = [];
  const objects = await git(["rev-list", "--objects", `${baseSha}..HEAD`]);
  if (objects.code === 0) {
    const ids = objects.stdout
      .split("\n")
      .map((l) => l.split(" ")[0] ?? "")
      .filter((id) => /^[0-9a-f]{40,64}$/.test(id));
    const s = searcher(secrets);
    await catFileBatch(work, ids, (c) => s.feed(c));
    if (s.found) where.push(`the commits since ${baseSha.slice(0, 7)}`);
  } else {
    where.push(`the commits since ${baseSha.slice(0, 7)} (unreadable: ${objects.stderr.trim()})`);
  }
  const changed = await git([
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  for (const record of changed.stdout.split("\0").filter(Boolean)) {
    const path = record.slice(3);
    const full = join(work, path);
    const stat = await lstat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    const s = searcher(secrets);
    s.feed(await readFile(full));
    if (s.found) where.push(path);
  }
  return where;
}
