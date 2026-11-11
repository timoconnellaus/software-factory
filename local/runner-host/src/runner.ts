// Wires a runner from its config: the signed channel client, the host's git, and the Orca adapter
// with the Claude harness. This is the one place that names a runner adapter; the host loop and the
// job lifecycle only see the contract.
import { DEFAULT_IDENTITY } from "@software-factory/harness-claude";
import { httpControlPlane } from "@software-factory/runner-contract";
import {
  createOrcaRunner,
  type Exec,
  nodeExec,
  type OrcaRunnerConfig,
  reapOrphanWorktrees,
} from "@software-factory/runner-orca";
import type { Paths, RunnerConfig } from "./config.ts";
import { hostGit } from "./git.ts";
import { RunnerHost } from "./host.ts";

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
    resolveRepoPath: (job) => git.clonePath(job),
    startPoint: (job) => git.startPoint(job, git.clonePath(job)),
    // The harness must not read the runner's key, its other runs, or the clones' git internals.
    protectPaths: [dirs.configDir, dirs.runsDir, dirs.reposDir],
    identity,
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...options.orca,
  });
  const host = new RunnerHost({
    adapter,
    cp,
    git,
    maxConcurrent: config.maxConcurrent,
    heartbeatMs: config.heartbeatMs,
    reapOrphans: (running) => reapOrphanWorktrees(orcaOptions, running),
    ...(options.log ? { log: options.log } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { host, cp, git, adapter };
}
