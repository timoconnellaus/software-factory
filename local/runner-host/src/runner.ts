// Wires a runner from its config: the signed channel client, the host's git, and the Orca adapter
// with the Claude harness. This is the one place that names a runner adapter; the host loop and the
// job lifecycle only see the contract.

import { join } from "node:path";
import { DEFAULT_IDENTITY } from "@software-factory/harness-claude";
import { httpControlPlane } from "@software-factory/runner-contract";
import {
  createOrcaRunner,
  type Exec,
  migrateRunnerRepos,
  nodeExec,
  type OrcaRunnerConfig,
  reapOrphanWorktrees,
} from "@software-factory/runner-orca";
import type { Paths, RunnerConfig } from "./config.ts";
import { hostGit } from "./git.ts";
import { RunnerHost } from "./host.ts";

/** Where a running host records its live jobs (read by `status` and `doctor`). */
export const liveJobsFile = (dirs: Paths) => join(dirs.stateDir, "live-jobs.json");

export function buildRunner(
  config: RunnerConfig,
  dirs: Paths,
  options: {
    exec?: Exec;
    fetch?: typeof fetch;
    log?: (m: string) => void;
    orca?: Partial<OrcaRunnerConfig>;
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
  const orcaOptions = { ...(config.orcaBin ? { bin: config.orcaBin } : {}), exec };
  const adapter = createOrcaRunner({
    ...orcaOptions,
    maxConcurrent: config.maxConcurrent,
    runsDir: dirs.runsDir,
    // ADR 0260: jobs run in the Orca repo this machine already has for the remote; the host's
    // clone is only the fallback when there is none, registered once and kept.
    resolveRepoPath: (job) => git.clonePath(job),
    ownReposDir: dirs.reposDir,
    startPoint: (job, repoPath) => git.startPoint(job, repoPath),
    // The harness must not read the runner's key, its other runs, or the clones' git internals.
    protectPaths: [dirs.configDir, dirs.runsDir, dirs.reposDir],
    identity,
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...options.orca,
  });
  const log = options.log ?? ((m: string) => console.log(`[runner] ${m}`));
  const host = new RunnerHost({
    adapter,
    cp,
    git,
    maxConcurrent: config.maxConcurrent,
    heartbeatMs: config.heartbeatMs,
    reapOrphans: (running) => reapOrphanWorktrees(orcaOptions, running),
    // Retire clones an earlier runner registered next to the owner's own checkout (ADR 0260). It
    // runs after the orphans are reaped and before the first claim, so no job is using them.
    onStart: async () => {
      for (const m of await migrateRunnerRepos({
        ...orcaOptions,
        ownReposDir: dirs.reposDir,
        live: new Set(host.activeJobs),
      })) {
        log(
          m.skipped
            ? `repo migration for ${m.key} skipped: ${m.skipped}`
            : `${m.key}: jobs now run in ${m.kept.path}; unregistered and deleted the runner's clone ${m.retired.path}`,
        );
      }
    },
    liveJobsFile: liveJobsFile(dirs),
    log,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { host, cp, git, adapter };
}
