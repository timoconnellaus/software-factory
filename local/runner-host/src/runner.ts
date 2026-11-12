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
  createSpritesRunner,
  credentialForAccount,
  credentialFrom,
  dockerRuntime,
  type Exec,
  type LocalRunnerConfig,
  type ModelCredential,
  nodeExec,
  readSpritesToken,
  reapCheckContainers,
  reapContainers,
  reapOrphans,
  reapSprites,
  type SandboxApi,
  type SpritesOptions,
  spritePrefix,
  spritesApi,
} from "@software-factory/runner-local";
import {
  accountConfigDirs,
  accountPaths,
  accountsReport,
  activeAccount,
  noteUsage,
  useAccount,
} from "./accounts.ts";
import { localChecks } from "./check-mode.ts";
import { checkSandbox } from "./check-sandbox.ts";
import { checkoutDirs } from "./checkouts.ts";
import { checkSettingsSchema, type Paths, type RunnerConfig } from "./config.ts";
import { FETCH_NAMESPACE, hostGit } from "./git.ts";
import { RunnerHost } from "./host.ts";
import { hostLoad, LoadGate, type LoadReading, loadPolicySchema } from "./load.ts";
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

/** The most a sprite may live (ADR 0480), from runner.json. */
export const spriteLifetimeMs = (config: Pick<RunnerConfig, "sprites">) =>
  (config.sprites?.maxLifetimeMinutes ?? 240) * 60_000;

/** A sprites runner's dirs and API, for reaping and `doctor` (ADR 0480). */
export async function spriteDirs(
  config: Pick<RunnerConfig, "sprites" | "runnerId">,
  dirs: Paths,
  api?: SandboxApi,
) {
  return {
    spritesDir: dirs.spritesDir,
    runsDir: dirs.runsDir,
    namePrefix: spritePrefix(config.runnerId),
    maxAgeMs: spriteLifetimeMs(config),
    api:
      api ??
      spritesApi({
        token: await readSpritesToken(dirs.spritesTokenFile),
        ...(config.sprites?.apiUrl ? { apiUrl: config.sprites.apiUrl } : {}),
      }),
  };
}

export function buildRunner(
  config: RunnerConfig,
  dirs: Paths,
  options: {
    exec?: Exec;
    fetch?: typeof fetch;
    log?: (m: string) => void;
    local?: Partial<LocalRunnerConfig>;
    /** The load average and CPU count (tests inject them; ADR 0552). */
    loadReading?: () => LoadReading;
    /** Container isolation's overrides (tests: a scripted runtime, a credential). */
    container?: Partial<ContainerOptions>;
    /** Sprites isolation's overrides (tests: the fake API, a credential). */
    sprites?: Partial<SpritesOptions>;
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
  const containers = config.isolation === "container";
  const checkSettings = checkSettingsSchema.parse(config.checks ?? {});
  const sprites = config.isolation === "sprites";
  // A Mac sandbox runner's check containers (ADR 0501, fourth review): the runtime its checks run
  // on, and that reaps what a runner that died mid-check left (fifth review).
  const checkRuntime =
    !containers && !sprites && process.platform === "darwin"
      ? (options.container?.runtime ?? dockerRuntime({ exec, bin: dockerBin(config) }))
      : null;
  const reapChecks = (running: Set<string>) =>
    checkRuntime ? reapCheckContainers(checkRuntime, running) : Promise.resolve([] as string[]);
  // Claim nothing heavy, then nothing at all, while the machine is overloaded (ADR 0552). Checks
  // wait on the same gate before they start (fifth review).
  const load = new LoadGate(
    loadPolicySchema.parse(config.load ?? {}),
    options.loadReading ?? hostLoad,
    log,
  );
  // A stream-json session (ADR 0450) runs on the host only: a container or sprite job keeps tmux.
  const sessionMode = containers || sprites ? "tmux" : config.session;
  if ((containers || sprites) && config.session === "stream-json") {
    log(`session: stream-json is not available with ${config.isolation} isolation yet; using tmux`);
  }
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
    // ADR 0501: nor the jobs' check trees (another job's agent could forge this job's evidence).
    // Nor the check sandbox's sockets (a check's network goes through them).
    protectPaths: [
      dirs.configDir,
      dirs.runsDir,
      dirs.reposDir,
      dirs.checksDir,
      dirs.checkSocketsDir,
    ],
    identity,
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    // tmux (default) or a stream-json session shown as a chat (ADR 0450).
    session: sessionMode,
    ...options.local,
  };
  // ADR 0430: a container per job when the owner opts in; ADR 0480: a sprite per job; else the
  // worktree and Claude's sandbox.
  const adapter = sprites
    ? createSpritesRunner({
        ...localConfig,
        sprites: {
          tokenFile: dirs.spritesTokenFile,
          spritesDir: dirs.spritesDir,
          namePrefix: spritePrefix(config.runnerId),
          modelCredential: hostModelCredential(config),
          fetchNamespace: FETCH_NAMESPACE,
          ...(config.sprites?.apiUrl ? { apiUrl: config.sprites.apiUrl } : {}),
          ...(config.sprites?.allowedHosts ? { allowedHosts: config.sprites.allowedHosts } : {}),
          size: {
            ...(config.sprites?.cpus ? { cpus: config.sprites.cpus } : {}),
            ...(config.sprites?.memoryMb ? { memoryMb: config.sprites.memoryMb } : {}),
            ...(config.sprites?.storageGb ? { storageGb: config.sprites.storageGb } : {}),
          },
          maxLifetimeMs: spriteLifetimeMs(config),
          log,
          ...options.sprites,
        },
      })
    : containers
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
    // ADR 0501: a job without a container runs its checks under the host's OS sandbox, never as the
    // owner; none of the runner's own dirs or the owner's checkouts are readable there. Only for the
    // default isolation: a container runner checks in containers, and any other (a sprite per job)
    // never runs a job's checks on this machine (they are reported not run).
    // Fourth review: on a Mac, a fresh check container when a container runtime answers; with
    // none, not run, unless runner.json opts in to the weaker macOS sandbox (./check-mode.ts).
    checkSandbox:
      (config.isolation ?? "sandbox") !== "sandbox"
        ? null
        : localChecks({
            weakerMacSandbox: checkSettings.weakerMacSandbox,
            limits: {
              cpus: checkSettings.cpus,
              memory: `${Math.round(checkSettings.memoryGb * 1024)}m`,
              tmpSize: `${Math.round(checkSettings.tmpGb * 1024)}m`,
            },
            runtime: checkRuntime,
            sandbox: checkSandbox({
              protectPaths: [
                dirs.configDir,
                dirs.runsDir,
                dirs.reposDir,
                dirs.worktreesDir,
                ...checkoutDirs(config),
              ],
              socketsDir: dirs.checkSocketsDir,
              checksDir: dirs.checksDir,
            }),
          }),
    checksDir: dirs.checksDir,
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
        : sprites
          ? await spriteDirs(config, dirs, options.sprites?.api)
              .then((d) => reapSprites(d, running))
              .catch((err) => {
                // Never quiet: a sprite that wasn't destroyed may still be running and billed.
                log(
                  `REAPING SPRITES FAILED, some may still be running: ${err instanceof Error ? err.message : err}`,
                );
                return [] as string[];
              })
          : // A Mac sandbox runner's check containers, their proxies and networks: at start-up
            // `running` is empty, so every one a dead runner left goes.
            await reapChecks(running).catch((err) => {
              log(`reaping check containers: ${err instanceof Error ? err.message : err}`);
              return [] as string[];
            });
      const local = await reapOrphans(
        {
          ...hostDirs(dirs, exec),
          ...(options.local?.tmux ? { tmux: options.local.tmux } : {}),
          ...(options.local?.procs ? { procs: options.local.procs } : {}),
          // Marked run branches left by crashed jobs, in the owner's checkouts too (ADR 0551).
          checkouts: {
            dirs: checkoutDirs(config),
            exclude: [dirs.reposDir, dirs.worktreesDir],
            exec,
          },
        },
        running,
      );
      return [...new Set([...reaped, ...local])];
    },
    liveJobsFile: liveJobsFile(dirs),
    load,
    // At most this many checks at once, each a heavy job while it runs (fifth review).
    maxChecks: checkSettings.maxConcurrent,
    maxTreeBytes: Math.round(checkSettings.maxTreeGb * 1024 ** 3),
    // A sprites runner sweeps while it runs (ADR 0480): sprites no live job holds, or past their
    // lifetime, so none is left billing between restarts.
    ...(sprites
      ? {
          sweep: async (running: Set<string>) =>
            reapSprites(await spriteDirs(config, dirs, options.sprites?.api), running),
        }
      : checkRuntime
        ? // And a Mac sandbox runner's check containers whose job it no longer runs (fifth review).
          // A runtime that isn't answering has none running: nothing to do, quietly.
          { sweep: (running: Set<string>) => reapChecks(running).catch(() => [] as string[]) }
        : {}),
    log,
    ...(options.selfUpdate ? { selfUpdate: options.selfUpdate } : {}),
    ...(options.onUpdated ? { onUpdated: options.onUpdated } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { host, cp, git, adapter };
}
