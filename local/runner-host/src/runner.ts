// Wires a runner from its config: the signed channel client, the host's git, and the local adapter
// (git worktrees + tmux, ADR 0380) with the Claude harness. This is the one place that names a
// runner adapter; the host loop and the job lifecycle only see the contract.

import { join } from "node:path";
import { DEFAULT_IDENTITY } from "@software-factory/harness-claude";
import { httpControlPlane } from "@software-factory/runner-contract";
import {
  createLocalRunner,
  type Exec,
  type LocalRunnerConfig,
  nodeExec,
  reapOrphans,
} from "@software-factory/runner-local";
import { checkoutDirs } from "./checkouts.ts";
import type { Paths, RunnerConfig } from "./config.ts";
import { hostGit } from "./git.ts";
import { RunnerHost } from "./host.ts";
import type { SelfUpdate } from "./self-update.ts";

/** Where a running host records its live jobs (read by `status` and `doctor`). */
export const liveJobsFile = (dirs: Paths) => join(dirs.stateDir, "live-jobs.json");

/** The adapter's own dirs, for reaping and `doctor`. */
export const hostDirs = (dirs: Paths, exec: Exec = nodeExec) => ({
  worktreesDir: dirs.worktreesDir,
  runsDir: dirs.runsDir,
  attachmentsDir: dirs.attachmentsDir,
  exec,
});

export function buildRunner(
  config: RunnerConfig,
  dirs: Paths,
  options: {
    exec?: Exec;
    fetch?: typeof fetch;
    log?: (m: string) => void;
    local?: Partial<LocalRunnerConfig>;
    /** The runner's self-update (ADR 0360), and what to do once it has updated. */
    selfUpdate?: SelfUpdate;
    onUpdated?: () => void;
  } = {},
) {
  const exec = options.exec ?? nodeExec;
  const cp = httpControlPlane({
    baseUrl: config.baseUrl,
    runnerId: config.runnerId,
    key: config.key,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const identity = config.identity ?? DEFAULT_IDENTITY;
  const git = hostGit({
    exec,
    reposDir: dirs.reposDir,
    identity,
    ...(config.repoUrlMap ? { repoUrlMap: config.repoUrlMap } : {}),
  });
  const adapter = createLocalRunner({
    exec,
    maxConcurrent: config.maxConcurrent,
    // ADR 0260 (amended by ADR 0380): jobs run as worktrees of the checkout this machine already
    // has for the remote, under the configured `checkouts` dirs; the host's clone only when none.
    checkouts: checkoutDirs(config),
    resolveRepoPath: (job) => git.clonePath(job),
    ownReposDir: dirs.reposDir,
    worktreesDir: dirs.worktreesDir,
    runsDir: dirs.runsDir,
    attachmentsDir: dirs.attachmentsDir,
    startPoint: (job, checkout) => git.startPoint(job, checkout),
    // The harness must not read the runner's key, its other runs, or the clones' git internals.
    protectPaths: [dirs.configDir, dirs.runsDir, dirs.reposDir],
    identity,
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    ...options.local,
  });
  const log = options.log ?? ((m: string) => console.log(`[runner] ${m}`));
  const host = new RunnerHost({
    adapter,
    cp,
    git,
    maxConcurrent: config.maxConcurrent,
    maxLight: config.maxLight,
    heartbeatMs: config.heartbeatMs,
    reapOrphans: (running) =>
      reapOrphans(
        {
          ...hostDirs(dirs, exec),
          ...(options.local?.tmux ? { tmux: options.local.tmux } : {}),
        },
        running,
      ),
    liveJobsFile: liveJobsFile(dirs),
    log,
    ...(options.selfUpdate ? { selfUpdate: options.selfUpdate } : {}),
    ...(options.onUpdated ? { onUpdated: options.onUpdated } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { host, cp, git, adapter };
}
