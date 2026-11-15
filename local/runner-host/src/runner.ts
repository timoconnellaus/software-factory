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
import { accountPaths, accountsReport, activeAccount, noteUsage, useAccount } from "./accounts.ts";
import { checkoutDirs } from "./checkouts.ts";
import type { Paths, RunnerConfig } from "./config.ts";
import { hostGit } from "./git.ts";
import { RunnerHost } from "./host.ts";
import { hostLoad, LoadGate, type LoadReading, loadPolicySchema } from "./load.ts";
import type { SelfUpdate } from "./self-update.ts";

/** Where a running host records its live jobs (read by `status` and `doctor`). */
export const liveJobsFile = (dirs: Paths) => join(dirs.stateDir, "live-jobs.json");

/** The adapter's own dirs, for reaping and `doctor`. */
export const hostDirs = (dirs: Paths, exec: Exec = nodeExec) => ({
  worktreesDir: dirs.worktreesDir,
  runsDir: dirs.runsDir,
  exec,
});

/**
 * Why this runner takes no jobs, from its config, or null: `container` and `sprites` isolation
 * were removed with the old pipeline (spec 70 milestone 5).
 */
export function retiredIsolation(config: Pick<RunnerConfig, "isolation">): string | null {
  const isolation = config.isolation ?? "sandbox";
  return isolation === "sandbox"
    ? null
    : `runner.json says "isolation": "${isolation}", which this runner no longer has: it takes no jobs until that is "sandbox"`;
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
  // Claim nothing heavy, then nothing at all, while the machine is overloaded (ADR 0552).
  const load = new LoadGate(
    loadPolicySchema.parse(config.load ?? {}),
    options.loadReading ?? hostLoad,
    log,
  );
  const localConfig: LocalRunnerConfig = {
    exec,
    // Claude accounts (ADR 0410): a job takes the active one when its workspace is prepared.
    account: () => activeAccount(accounts),
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
    startPoint: (job, checkout) => git.startPoint(job, checkout),
    // The harness must not read the runner's key, its other runs, or the clones' git internals.
    protectPaths: [dirs.configDir, dirs.runsDir, dirs.reposDir],
    identity,
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    // tmux (default) or a stream-json session (ADR 0450).
    session: config.session,
    ...options.local,
  };
  const adapter = createLocalRunner(localConfig);
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
    reapOrphans: (running) =>
      reapOrphans(
        {
          ...hostDirs(dirs, exec),
          ...(options.local?.tmux ? { tmux: options.local.tmux } : {}),
          ...(options.local?.procs ? { procs: options.local.procs } : {}),
          // Marked branches left by crashed jobs, in the owner's checkouts too (ADR 0551).
          checkouts: {
            dirs: checkoutDirs(config),
            exclude: [dirs.reposDir, dirs.worktreesDir],
            exec,
          },
        },
        running,
      ),
    liveJobsFile: liveJobsFile(dirs),
    load,
    log,
    ...(options.selfUpdate ? { selfUpdate: options.selfUpdate } : {}),
    ...(options.onUpdated ? { onUpdated: options.onUpdated } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  // A runner.json that still names a removed isolation takes nothing (and says why) until fixed.
  const retired = retiredIsolation(config);
  if (retired) {
    log(retired);
    void host.drain();
  }
  return { host, cp, git, adapter };
}
