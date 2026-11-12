// Where this machine's checkouts are (`runner.json` `checkouts`, ADR 0260 amended by ADR 0380).
//
// History: the factory used to run jobs in the Orca desktop app, which kept the list of the owner's
// checkouts. When `checkouts` isn't set yet, `sf-runner login` and `sf-runner doctor --fix` fill it
// in once from that list, as the parent directories of the repos it had (a one-time migration).
// Without the app, or once set (even to `[]`), it is left alone. Nothing else reads the app.
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Exec, isUnder } from "@software-factory/runner-local";
import type { RunnerConfig } from "./config.ts";

/** `~/x` → `<home>/x`; relative paths resolve against home. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(home, path);
}

/** The configured checkout dirs, absolute. */
export function checkoutDirs(config: Pick<RunnerConfig, "checkouts">, home = homedir()): string[] {
  return (config.checkouts ?? []).map((p) => expandHome(p, home));
}

/**
 * The parent directories of the repos the desktop app knew, or `[]` without it. `exclude`: the
 * runner's own dirs (its clones), never offered as checkouts.
 */
export async function legacyCheckoutDirs(exec: Exec, exclude: string[]): Promise<string[]> {
  const r = await exec("orca", ["repo", "list", "--json"], { timeoutMs: 15_000 }).catch(() => null);
  if (r?.code !== 0) return [];
  let repos: Array<{ path?: unknown }> = [];
  try {
    const parsed = JSON.parse(r.stdout) as { result?: { repos?: Array<{ path?: unknown }> } };
    repos = parsed.result?.repos ?? [];
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const repo of repos) {
    if (typeof repo.path !== "string" || !isAbsolute(repo.path)) continue;
    if (exclude.some((x) => isUnder(repo.path as string, x))) continue;
    const dir = dirname(repo.path);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Sets `checkouts` once when it is unset. Returns the config to save and the dirs it chose, or
 * `null` when there was nothing to do.
 */
export async function migrateCheckouts(
  config: RunnerConfig,
  exec: Exec,
  exclude: string[],
): Promise<{ config: RunnerConfig; chosen: string[] | null }> {
  if (config.checkouts !== undefined) return { config, chosen: null };
  const chosen = await legacyCheckoutDirs(exec, exclude);
  return { config: { ...config, checkouts: chosen }, chosen };
}
