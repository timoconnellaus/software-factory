// Which checkout a job runs in (ADR 0260, amended by ADR 0350). A job runs as a worktree of the
// checkout this machine already has for its GitHub repo, found by canonical remote identity
// (`github.com/<owner>/<name>`) among the immediate git repos of the directories the owner listed
// in `runner.json` `checkouts`. Only when none matches does the host use its own clone. Isolation
// comes from the job's own worktree, never from a second checkout; nothing is registered anywhere.
import { access, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { canonicalKeyFromUrl, canonicalRepoKey, type Job } from "@software-factory/runner-contract";
import { type Exec, nodeExec } from "./exec.ts";

export interface Checkout {
  /** Real path (symlinks resolved). */
  path: string;
  /** Canonical identity of its `origin`, or null when it has none on GitHub. */
  key: string | null;
}

export interface CheckoutSearch {
  /** Directories whose immediate git repos are candidates. */
  dirs: readonly string[];
  /** Paths never used as a checkout (the runner's own clones and worktrees). */
  exclude?: readonly string[];
  exec?: Exec;
}

const canonical = async (path: string) => realpath(path).catch(() => path);

export function isUnder(path: string, dir: string | undefined): boolean {
  if (!dir) return false;
  const base = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return path === dir || path.startsWith(base);
}

/** The canonical identity of a checkout's `origin`, or null. */
export async function checkoutKey(path: string, exec: Exec = nodeExec): Promise<string | null> {
  const r = await exec("git", ["config", "--get", "remote.origin.url"], { cwd: path }).catch(
    () => null,
  );
  return r?.code === 0 ? canonicalKeyFromUrl(r.stdout) : null;
}

/**
 * Every main checkout directly under the search dirs (a directory with a `.git` directory: linked
 * worktrees and submodules, which have a `.git` file, are not checkouts), with its identity.
 */
export async function scanCheckouts(search: CheckoutSearch): Promise<Checkout[]> {
  const exec = search.exec ?? nodeExec;
  const exclude = await Promise.all((search.exclude ?? []).map(canonical));
  const seen = new Set<string>();
  const out: Checkout[] = [];
  for (const dir of search.dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = join(dir, entry.name);
      const isRepo = await readdir(join(candidate, ".git")).then(
        () => true,
        () => false,
      );
      if (!isRepo) continue;
      const path = await canonical(candidate);
      if (seen.has(path) || exclude.some((x) => isUnder(path, x))) continue;
      seen.add(path);
      out.push({ path, key: await checkoutKey(path, exec) });
    }
  }
  return out;
}

/**
 * The checkout a job must use: the one whose `origin` is the job's repo. Among several, the first
 * in the order the dirs were listed (then by name), so the choice is stable. Null when none.
 */
export function pickCheckout(checkouts: readonly Checkout[], key: string): Checkout | null {
  return checkouts.find((c) => c.key === key) ?? null;
}

export async function findCheckout(
  job: Pick<Job, "repo">,
  search: CheckoutSearch,
): Promise<Checkout | null> {
  if (search.dirs.length === 0) return null;
  return pickCheckout(await scanCheckouts(search), canonicalRepoKey(job.repo));
}

/** Checkouts that share a remote: the owner has two clones of one repo under the search dirs. */
export function duplicateCheckouts(checkouts: readonly Checkout[]): Map<string, Checkout[]> {
  const byKey = new Map<string, Checkout[]>();
  for (const c of checkouts) {
    if (!c.key) continue;
    byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  }
  return new Map([...byKey].filter(([, list]) => list.length > 1));
}

export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
