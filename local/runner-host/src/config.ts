// The runner's configuration and its key (ADR 0016). The key is the runner's only secret: it signs
// every channel call. It lives in a 0600 file in a 0700 directory, and the harness's settings deny
// reading it. Paths follow XDG on every platform so the service (launchd or systemd) and a shell
// agree; only the log moves to ~/Library/Logs on macOS.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CAPABILITIES, type Capability } from "@software-factory/runner-contract";
import { z } from "zod";
import { loadPolicySchema } from "./load.ts";

export const DEFAULT_BASE_URL = "https://sf-engine.zerobsai.com";
/** The app, where a person approves `sf-runner login` (when the engine's link is relative). */
export const DEFAULT_APP_URL = "https://software-factory.zerobsai.com";

export const configSchema = z.object({
  baseUrl: z.string().url().default(DEFAULT_BASE_URL),
  runnerId: z.string().regex(/^r_[a-z0-9]{6,32}$/),
  key: z.string().min(20),
  name: z.string().max(80).optional(),
  maxConcurrent: z.number().int().min(1).max(16).default(2),
  /** Light slots (triage, spec, planning sessions), ADR 0301. An idle planning session holds one. */
  maxLight: z.number().int().min(0).max(32).default(6),
  heartbeatMs: z.number().int().min(2_000).max(120_000).default(20_000),
  /** Capabilities to declare (default: everything the adapter supports). */
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  identity: z.object({ name: z.string(), email: z.string() }).optional(),
  /**
   * How jobs' sessions run (ADR 0450): `tmux`, Claude Code's TUI in tmux (takeover by `tmux
   * attach`), or `stream-json`, Claude headless as a two-way stream the dashboard shows as a chat
   * (declares `chat`; takeover by `claude --resume`). Changing it takes a restart.
   */
  session: z.enum(["tmux", "stream-json"]).default("tmux"),
  /**
   * Directories whose immediate git repos are this machine's checkouts (ADR 0260, amended by ADR
   * 0380): a job runs as a worktree of the one whose `origin` is the job's repo, else in the host's
   * own clone. Unset until `login` or `doctor --fix` fills it in once.
   */
  checkouts: z.array(z.string()).optional(),
  /**
   * Update the runner's own checkout to the commit the factory was deployed from (ADR 0360).
   * `false` turns it off; the runner then reports `blocked` when it is behind.
   */
  autoUpdate: z.boolean().default(true),
  /**
   * Back off claiming under load (ADR 0552), as multiples of the CPU count: heavy jobs stop when
   * the 1-minute load average passes `heavyStop` (1.5), light ones too past `lightStop` (2.0), and
   * each resumes below its stop × `resumeFactor` (0.8). On by default; `enabled: false` turns it off.
   */
  load: loadPolicySchema.optional(),
  /**
   * Test only: how long a pending update waits before the host takes light jobs only, and before it
   * takes nothing (ADR 0520; defaults 30 and 60 minutes). Leave it out of a real runner.json.
   */
  updateCaps: z
    .object({
      heavyAfterMinutes: z.number().min(0).max(1_440).optional(),
      allAfterMinutes: z.number().min(0).max(1_440).optional(),
    })
    .strict()
    .optional(),
  /**
   * Where jobs run (ADR 0430): `sandbox` (default) is a worktree with Claude Code's OS sandbox on
   * this machine (ADR 0270); `container` is a Docker container per job, every stage with
   * permissions off; `sprites` is a cloud sandbox per job on Sprites, made by this host (ADR 0480).
   */
  isolation: z.enum(["sandbox", "container", "sprites"]).default("sandbox"),
  /** Container isolation's settings (ADR 0430). */
  container: z
    .object({
      /** The `docker` CLI (default: found on PATH, Homebrew's or ~/.local/bin). */
      docker: z.string().optional(),
      /**
       * The model credential that goes into the container: `CLAUDE_CODE_OAUTH_TOKEN` (from
       * `claude setup-token`) or `ANTHROPIC_API_KEY`. Default: the same variable in sf-runner's own
       * environment. This file is 0600, like the runner key.
       */
      env: z
        .object({
          CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
          ANTHROPIC_API_KEY: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
      /** More egress hosts for every job on this runner, on top of the stage's. */
      allowedHosts: z.array(z.string().min(1).max(260)).max(100).optional(),
      cpus: z.number().positive().max(256).optional(),
      /** Docker's syntax: `8g`, `512m`. */
      memory: z
        .string()
        .regex(/^\d+[bkmg]?$/i)
        .optional(),
      pids: z.number().int().min(64).max(1_000_000).optional(),
    })
    .strict()
    .optional(),
  /**
   * Sprites isolation's settings (ADR 0480): a fresh sprite per job, made by this host with the
   * owner's Sprites token. The token is not here: `sf-runner sprites login` keeps it in its own
   * 0600 file next to this one. The model credential is the active Claude account's token.
   */
  sprites: z
    .object({
      /** The Sprites API (default `https://api.sprites.dev`). */
      apiUrl: z.string().url().optional(),
      /** More egress hosts for every job on this runner, on top of the stage's. */
      allowedHosts: z.array(z.string().min(1).max(260)).max(100).optional(),
      /** Each sprite's size, sent at creation (defaults: 4 CPUs, 8192 MB, 50 GB). */
      cpus: z.number().int().min(1).max(16).optional(),
      memoryMb: z.number().int().min(1024).max(65_536).optional(),
      storageGb: z.number().int().min(10).max(500).optional(),
      /**
       * The most a sprite may live, in minutes (default 240): Claude is stopped then, and the
       * host's sweep destroys any of its sprites older than this.
       */
      maxLifetimeMinutes: z
        .number()
        .int()
        .min(10)
        .max(24 * 60)
        .optional(),
    })
    .strict()
    .optional(),
  /** Test only: clone/push URL per canonical GitHub URL. */
  repoUrlMap: z.record(z.string(), z.string()).optional(),
});
export type RunnerConfig = z.infer<typeof configSchema>;

export interface Paths {
  configFile: string;
  configDir: string;
  stateDir: string;
  reposDir: string;
  runsDir: string;
  /**
   * Job worktrees: `<worktreesDir>/sf-<jobId>`. Under the data dir, not the state dir: the harness
   * denies reads of `~/.local/state/software-factory` (harness-claude `DENY_HOME`), and the agent
   * must read its own worktree (incident 2026-11-11-bootstrap #10).
   */
  worktreesDir: string;
  /**
   * The jobs' check trees (ADR 0501): `<checksDir>/<jobId>-…`. Not the system temp dir, which every
   * agent may write, and not under the state dir, which the harness's floor denies (a check could
   * then not read its own tree). Every harness's protectPaths names it, so no agent reaches it.
   */
  checksDir: string;
  /**
   * The check sandbox's own sockets (ADR 0501, amended 2026-11-12, third review): the sandbox
   * runtime's proxy sockets go in a short private dir here (`<checkSocketsDir>/c…`), not in the
   * check's temp, whose path is too long for a unix socket (104 bytes on macOS, 108 on Linux). No
   * check can write it, and every harness's protectPaths names it, so no agent reaches it.
   */
  checkSocketsDir: string;
  /** Each run's attachments (`<attachmentsDir>/<jobId>`), which the agent reads: also not under state. */
  attachmentsDir: string;
  /**
   * Container jobs' dirs (`<containersDir>/sf-<jobId>/`: the job repo, home, temp) and their
   * credential env files (ADR 0430). Under the data dir: Docker Desktop shares the home dir.
   */
  containersDir: string;
  /** The owner's Sprites token (ADR 0480): 0600, under the config dir every run denies. */
  spritesTokenFile: string;
  /** Sprites jobs' host-side dirs (`<spritesDir>/sf-<jobId>/`: the job repo and mirrored files). */
  spritesDir: string;
  /**
   * Claude accounts (ADR 0410): the registry (the active name, each account's kind; no secret),
   * the token files (0600), both under the config dir every run denies, and each account's Claude
   * config dir, under the data dir (Claude's sandboxed shell reads its snapshots from there).
   */
  accountsFile: string;
  accountTokensDir: string;
  accountConfigsDir: string;
  /**
   * The service's log (`runner.log`): `~/Library/Logs/software-factory` on macOS, else
   * `$XDG_STATE_HOME/software-factory/logs` (ADR 0420), under the state root the harness denies.
   */
  logDir: string;
}

export function paths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Paths {
  const home = env.HOME ?? homedir();
  const configDir = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "software-factory");
  const stateRoot = join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "software-factory");
  // The service gets SF_RUNNER_STATE_DIR from its definition, so the `sh` wrapper and Node agree.
  const stateDir = env.SF_RUNNER_STATE_DIR ?? join(stateRoot, "runner");
  const dataDir = join(
    env.XDG_DATA_HOME ?? join(home, ".local", "share"),
    "software-factory",
    "runner",
  );
  return {
    configFile: env.SF_RUNNER_CONFIG ?? join(configDir, "runner.json"),
    configDir,
    stateDir,
    reposDir: join(stateDir, "repos"),
    runsDir: join(stateDir, "runs"),
    worktreesDir: join(dataDir, "worktrees"),
    attachmentsDir: join(dataDir, "attachments"),
    checksDir: join(dataDir, "checks"),
    checkSocketsDir: join(dataDir, "s"),
    containersDir: join(dataDir, "containers"),
    spritesTokenFile: join(configDir, "sprites.token"),
    spritesDir: join(dataDir, "sprites"),
    accountsFile: join(configDir, "accounts.json"),
    accountTokensDir: join(configDir, "accounts"),
    accountConfigsDir: join(dataDir, "accounts"),
    logDir:
      platform === "darwin"
        ? join(home, "Library", "Logs", "software-factory")
        : join(stateRoot, "logs"),
  };
}

export async function loadConfig(file: string): Promise<RunnerConfig | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return configSchema.parse(JSON.parse(text));
}

export async function saveConfig(file: string, config: RunnerConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700).catch(() => {});
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** The config without its key, for `status`. */
export function redacted(config: RunnerConfig): Omit<RunnerConfig, "key"> & { key: string } {
  const env = config.container?.env;
  return {
    ...config,
    key: `${config.key.slice(0, 4)}…(redacted)`,
    ...(config.container && env
      ? {
          container: {
            ...config.container,
            env: Object.fromEntries(Object.keys(env).map((k) => [k, "(redacted)"])),
          },
        }
      : {}),
  };
}

export type { Capability };
