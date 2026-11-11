// Which Orca repo a job runs in (ADR 0260). A job always runs in the Orca repo that already exists
// for its GitHub repo on this machine, found by canonical remote identity, so Orca shows one project
// with one source repo. Isolation comes from the job's own worktree, never from a second checkout.
// Only when no Orca repo exists for the remote does the runner register its own clone, once, and
// keep it. It never unregisters a repo per job.
//
// Also here: the startup migration that retires a clone the runner registered earlier next to the
// owner's own checkout, and the checks `sf-runner doctor` runs.
import { realpath, rm, rmdir } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { canonicalKeyFromUrl, canonicalRepoKey, type Job } from "@software-factory/runner-contract";
import { type Exec, nodeExec } from "./exec.ts";
import { type OrcaCliOptions, type OrcaRepo, orcaCli } from "./orca-cli.ts";

export const JOB_COMMENT_PREFIX = "sf-job:";

type Orca = ReturnType<typeof orcaCli>;

export interface RepoOwnership {
  /** Where the runner keeps its own clones (`<state>/repos`). Repos under it are the runner's. */
  ownReposDir?: string;
}

/** The job id an `sf-job:<id>` worktree comment names, or null. */
export function jobIdOf(comment: string | undefined | null): string | null {
  return comment?.startsWith(JOB_COMMENT_PREFIX)
    ? comment.slice(JOB_COMMENT_PREFIX.length) || null
    : null;
}

const canonical = async (path: string) => realpath(path).catch(() => path);

export function isUnder(path: string, dir: string | undefined): boolean {
  if (!dir) return false;
  const base = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return path === dir || path.startsWith(base);
}

/**
 * Orca's canonical key for a repo (`gitRemoteIdentity.canonicalKey`), lower-cased. Older Orca
 * builds don't report it, so fall back to the checkout's `origin` URL.
 */
export async function repoKey(repo: OrcaRepo, exec: Exec = nodeExec): Promise<string | null> {
  const key = repo.gitRemoteIdentity?.canonicalKey;
  if (key) return key.toLowerCase();
  const url = repo.gitRemoteIdentity?.remoteUrl;
  if (url) return canonicalKeyFromUrl(url);
  const r = await exec("git", ["config", "--get", "remote.origin.url"], { cwd: repo.path }).catch(
    () => null,
  );
  return r?.code === 0 ? canonicalKeyFromUrl(r.stdout) : null;
}

function ownKey(path: string, ownDir: string | undefined): string | null {
  if (!ownDir) return null;
  const [owner, name, ...rest] = path.slice(ownDir.length).split(sep).filter(Boolean);
  return owner && name && rest.length === 0 ? canonicalRepoKey({ owner, name }) : null;
}

export interface KeyedRepo extends OrcaRepo {
  key: string | null;
  /** Real path (symlinks resolved). */
  realPath: string;
  /** Under the runner's own clones dir. */
  own: boolean;
}

export async function keyedRepos(
  orca: Orca,
  options: RepoOwnership & { exec?: Exec } = {},
): Promise<KeyedRepo[]> {
  const own = options.ownReposDir ? await canonical(options.ownReposDir) : undefined;
  const out: KeyedRepo[] = [];
  for (const repo of await orca.repoList()) {
    const realPath = await canonical(repo.path);
    const isOwn = isUnder(realPath, own) || isUnder(repo.path, options.ownReposDir);
    out.push({
      ...repo,
      // The runner's clones live at `<ownReposDir>/<owner>/<name>`, so their identity is their path
      // even when Orca can't read one.
      key: (await repoKey(repo, options.exec)) ?? (isOwn ? ownKey(realPath, own) : null),
      realPath,
      own: isOwn,
    });
  }
  return out;
}

/**
 * The Orca repo a job must use: the one whose canonical remote is the job's repo. The owner's own
 * checkout wins over a clone the runner registered; among several, the earliest added. Null when
 * this machine's Orca has none.
 */
export function pickRepo(repos: KeyedRepo[], key: string): KeyedRepo | null {
  const matches = repos
    .filter((r) => r.key === key && (r.kind === undefined || r.kind === "git"))
    .sort((a, b) => Number(a.own) - Number(b.own) || (a.addedAt ?? 0) - (b.addedAt ?? 0));
  return matches[0] ?? null;
}

export async function findRepoForJob(
  orca: Orca,
  job: Pick<Job, "repo">,
  options: RepoOwnership & { exec?: Exec } = {},
): Promise<KeyedRepo | null> {
  return pickRepo(await keyedRepos(orca, options), canonicalRepoKey(job.repo));
}

export interface Migration {
  key: string;
  /** The runner's repo that was retired. */
  retired: { id: string; path: string };
  /** The owner's repo jobs use from now on. */
  kept: { id: string; path: string };
  /** Job worktrees that were removed from the retired repo (orphans of a previous run). */
  removedWorktrees: string[];
  /** Why it was skipped, when it was. */
  skipped?: string;
}

/**
 * Retires clones the runner registered earlier (under `ownReposDir`) for a remote that also has an
 * owner repo in Orca: removes its leftover job worktrees, unregisters it and deletes the clone.
 * Skipped while a live job (in `live`) still has a worktree on it; new jobs already go to the
 * owner's repo, so the next start (or `sf-runner doctor --fix`) finishes it. `live: null` means the
 * live jobs can't be known, so every job worktree counts as live.
 */
export async function migrateRunnerRepos(
  options: OrcaCliOptions &
    Required<Pick<RepoOwnership, "ownReposDir">> & { live: Set<string> | null },
): Promise<Migration[]> {
  const orca = orcaCli(options);
  const exec = options.exec ?? nodeExec;
  const repos = await keyedRepos(orca, options);
  const out: Migration[] = [];
  for (const retired of repos.filter((r) => r.own && r.key)) {
    const kept = repos.find((r) => !r.own && r.key === retired.key);
    if (!kept || !retired.key) continue;
    const m: Migration = {
      key: retired.key,
      retired: { id: retired.id, path: retired.path },
      kept: { id: kept.id, path: kept.path },
      removedWorktrees: [],
    };
    out.push(m);
    const worktrees = (await orca.worktreePs()).filter((w) => w.repoId === retired.id);
    const busy = worktrees.find((w) => {
      const id = jobIdOf(w.comment);
      return id !== null && (options.live === null || options.live.has(id));
    });
    if (busy) {
      m.skipped = `job ${jobIdOf(busy.comment)} is still running in it`;
      continue;
    }
    for (const w of worktrees) {
      if (!jobIdOf(w.comment)) continue;
      await orca.terminalCloseAll(w.worktreeId).catch(() => {});
      await orca.worktreeRemove(w.worktreeId).catch(() => {});
      await rmdir(dirname(w.path)).catch(() => {});
      m.removedWorktrees.push(w.path);
    }
    await orca.repoForget(retired.id);
    // Only ever delete inside the runner's own clones dir.
    if (isUnder(retired.realPath, await canonical(options.ownReposDir))) {
      await rm(retired.realPath, { recursive: true, force: true });
      await rmdir(dirname(retired.realPath)).catch(() => {});
    }
    // The owner's repo may list the clone's worktrees as prunable now.
    await exec("git", ["worktree", "prune"], { cwd: kept.path }).catch(() => {});
  }
  return out;
}

export interface Finding {
  kind: "duplicate-repos" | "orphan-worktree";
  message: string;
  /** Whether `--fix` can repair it without touching the owner's own checkouts. */
  fixable: boolean;
}

/**
 * What `sf-runner doctor` checks: an Orca project (canonical remote) with more than one source repo,
 * and `sf-job:` worktrees without a live job.
 */
export async function diagnose(
  options: OrcaCliOptions & RepoOwnership & { live: Set<string> },
): Promise<Finding[]> {
  const orca = orcaCli(options);
  const repos = await keyedRepos(orca, options);
  const findings: Finding[] = [];
  const byKey = new Map<string, KeyedRepo[]>();
  for (const r of repos) {
    if (!r.key) continue;
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  }
  // Orca's projects group source repos by the same identity; count those too, in case a repo's
  // key couldn't be read here.
  const projects = await orca.projectList().catch(() => []);
  for (const p of projects) {
    const key = p.gitRemoteIdentity?.canonicalKey?.toLowerCase();
    if (!key || (p.sourceRepoIds?.length ?? 0) <= 1 || byKey.has(key)) continue;
    byKey.set(
      key,
      repos.filter((r) => p.sourceRepoIds?.includes(r.id)),
    );
  }
  for (const [key, list] of byKey) {
    if (list.length <= 1) continue;
    const owners = list.filter((r) => !r.own);
    findings.push({
      kind: "duplicate-repos",
      message: `${key} has ${list.length} source repos in Orca: ${list
        .map((r) => `${r.path}${r.own ? " (the runner's clone)" : ""}`)
        .join(", ")}`,
      // The fix retires the runner's clone; two of the owner's own checkouts are theirs to sort out.
      fixable: owners.length >= 1 && list.some((r) => r.own),
    });
  }
  for (const w of await orca.worktreePs()) {
    const id = jobIdOf(w.comment);
    if (!id || options.live.has(id)) continue;
    findings.push({
      kind: "orphan-worktree",
      message: `job worktree ${w.path} (${w.comment}) has no running job`,
      fixable: true,
    });
  }
  return findings;
}
