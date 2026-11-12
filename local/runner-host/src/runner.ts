// Wires a runner from its config: the signed channel client, the host's git, and the local adapter
// (git worktrees + tmux, ADR 0380) with the Claude harness. This is the one place that names a
// runner adapter; the host loop and the job lifecycle only see the contract.

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IDENTITY, type HarnessAccount } from "@software-factory/harness-claude";
import { httpControlPlane, type Job } from "@software-factory/runner-contract";
import {
  type ContainerOptions,
  createContainerRunner,
  createLocalRunner,
  credentialForAccount,
  credentialFrom,
  dockerRuntime,
  type Exec,
  type LocalRunnerConfig,
  type ModelCredential,
  nodeExec,
  reapContainers,
  reapOrphans,
} from "@software-factory/runner-local";
import {
  accountConfigDirs,
  accountPaths,
  accountsReport,
  activeAccount,
  noteUsage,
  useAccount,
} from "./accounts.ts";
import { checkoutDirs } from "./checkouts.ts";
import type { Paths, RunnerConfig } from "./config.ts";
import { FETCH_NAMESPACE, hostGit } from "./git.ts";
import { RunnerHost } from "./host.ts";
import { findOnPath } from "./pairing.ts";
import type { SelfUpdate } from "./self-update.ts";

/**
 * The `docker` CLI a container runner uses: runner.json's, else on PATH, Homebrew's, OrbStack's
 * (`~/.local/bin`) or Docker Desktop's app bundle.
 */
export function dockerBin(config: Pick<RunnerConfig, "container">): string {
  return (
    config.container?.docker ??
    findOnPath("docker", process.env.PATH, undefined, [
      join(process.env.HOME ?? homedir(), ".local", "bin"),
      "/Applications/Docker.app/Contents/Resources/bin",
    ]) ??
    "docker"
  );
}

/**
 * The model credential for a container job (ADR 0430 §8), from the Claude account the job took
 * (ADR 0410): a token account's token; a login account is refused (container isolation needs a
 * token account); the `default` account uses runner.json's `container.env`, else sf-runner's own
 * environment.
 */
export function hostModelCredential(
  config: Pick<RunnerConfig, "container">,
  env: NodeJS.ProcessEnv = process.env,
): (job: Job | undefined, account: HarnessAccount) => Promise<ModelCredential | null> {
  return (_job, account) =>
    credentialForAccount(account, () => credentialFrom(config.container?.env, env));
}

/** Where a running host records its live jobs (read by `status` and `doctor`). */
export const liveJobsFile = (dirs: Paths) => join(dirs.stateDir, "live-jobs.json");

/** The adapter's own dirs, for reaping and `doctor`. */
export const hostDirs = (dirs: Paths, exec: Exec = nodeExec) => ({
  worktreesDir: dirs.worktreesDir,
  runsDir: dirs.runsDir,
  attachmentsDir: dirs.attachmentsDir,
  exec,
});

/** A container runner's dirs and runtime, for reaping and `doctor` (ADR 0430). */
export const containerDirs = (
  config: Pick<RunnerConfig, "container">,
  dirs: Paths,
  exec: Exec = nodeExec,
) => ({
  containersDir: dirs.containersDir,
  runsDir: dirs.runsDir,
  runtime: dockerRuntime({ exec, bin: dockerBin(config) }),
});

export function buildRunner(
  config: RunnerConfig,
  dirs: Paths,
  options: {
    exec?: Exec;
    fetch?: typeof fetch;
    log?: (m: string) => void;
    local?: Partial<LocalRunnerConfig>;
    /** Container isolation's overrides (tests: a scripted runtime, a credential). */
    container?: Partial<ContainerOptions>;
    /** The runner's self-update (ADR 0360), and what to do once it has updated. */
    selfUpdate?: SelfUpdate;
    onUpdated?: () => void;
  } = {},
) {
  const exec = options.exec ?? nodeExec;
  const log = options.log ?? ((m: string) => console.log(`[runner] ${m}`));
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
  const accounts = accountPaths(dirs);
  const localConfig: LocalRunnerConfig = {
    exec,
    // Claude accounts (ADR 0410): a job takes the active one when its workspace is prepared.
    account: () => activeAccount(accounts),
    accountConfigDirs: () => accountConfigDirs(accounts),
    onAccountUsage: (name, limit) => {
      if (limit) log(`account "${name}" hit a usage limit: ${limit}`);
      void noteUsage(accounts, name, limit).catch((err) => {
        log(`account limits: ${err instanceof Error ? err.message : err}`);
      });
    },
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
  };
  const containers = config.isolation === "container";
  // ADR 0430: a container per job when the owner opts in; else the worktree and Claude's sandbox.
  const adapter = containers
    ? createContainerRunner({
        ...localConfig,
        container: {
          containersDir: dirs.containersDir,
          bin: dockerBin(config),
          modelCredential: hostModelCredential(config),
          fetchNamespace: FETCH_NAMESPACE,
          ...(config.container?.allowedHosts
            ? { allowedHosts: config.container.allowedHosts }
            : {}),
          ...(config.container?.cpus ? { cpus: config.container.cpus } : {}),
          ...(config.container?.memory ? { memory: config.container.memory } : {}),
          ...(config.container?.pids ? { pidsLimit: config.container.pids } : {}),
          log,
          ...options.container,
        },
      })
    : createLocalRunner(localConfig);
  const host = new RunnerHost({
    accounts: {
      report: () => accountsReport(accounts),
      use: (name) => useAccount(accounts, name),
    },
    adapter,
    cp,
    git,
    maxConcurrent: config.maxConcurrent,
    maxLight: config.maxLight,
    heartbeatMs: config.heartbeatMs,
    reapOrphans: async (running) => {
      // Container jobs first, with plain file operations: their job repos are never touched by git.
      const reaped = containers
        ? await reapContainers(
            {
              ...containerDirs(config, dirs, exec),
              ...(options.container?.runtime ? { runtime: options.container.runtime } : {}),
            },
            running,
          ).catch(() => [] as string[])
        : [];
      const local = await reapOrphans(
        {
          ...hostDirs(dirs, exec),
          ...(options.local?.tmux ? { tmux: options.local.tmux } : {}),
        },
        running,
      );
      return [...new Set([...reaped, ...local])];
    },
    liveJobsFile: liveJobsFile(dirs),
    log,
    ...(options.selfUpdate ? { selfUpdate: options.selfUpdate } : {}),
    ...(options.onUpdated ? { onUpdated: options.onUpdated } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { host, cp, git, adapter };
}
