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
  /** The heavy pool's size (ADR 0301), as reported; no job uses it now. */
  maxConcurrent: z.number().int().min(1).max(16).default(2),
  /** Concurrent jobs: the light pool, where every flow job runs (ADR 0301). */
  maxLight: z.number().int().min(0).max(32).default(6),
  heartbeatMs: z.number().int().min(2_000).max(120_000).default(20_000),
  /** Capabilities to declare (default: everything the adapter supports). */
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  identity: z.object({ name: z.string(), email: z.string() }).optional(),
  /**
   * How jobs' sessions run (ADR 0450): `tmux`, Claude Code's TUI in tmux (takeover by `tmux
   * attach`), or `stream-json`, Claude headless as a stream whose events carry tool results and
   * token counts (declares `chat`). Changing it takes a restart.
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
   * Where jobs run (ADR 0661): `sandbox` (default), a worktree or a plain directory on this machine
   * with Claude Code's OS sandbox (ADR 0270); `container`, each job's Claude in its own Docker
   * container on this machine, with permissions off inside it (needs Docker Desktop, OrbStack or
   * Docker Engine, and a token account). `sprites` (ADR 0480) was removed with the old pipeline: a
   * runner.json that still names it takes no jobs. Changing it takes a restart.
   */
  isolation: z.enum(["sandbox", "container", "sprites"]).default("sandbox"),
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
  return { ...config, key: `${config.key.slice(0, 4)}…(redacted)` };
}

export type { Capability };
