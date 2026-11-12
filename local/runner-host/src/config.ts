// The runner's configuration and its key (ADR 0016). The key is the runner's only secret: it signs
// every channel call. It lives in a 0600 file in a 0700 directory, and the harness's settings deny
// reading it. Paths follow XDG on every platform so the service (launchd or systemd) and a shell
// agree; only the log moves to ~/Library/Logs on macOS.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CAPABILITIES, type Capability } from "@software-factory/runner-contract";
import { z } from "zod";

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
  /** Each run's attachments (`<attachmentsDir>/<jobId>`), which the agent reads: also not under state. */
  attachmentsDir: string;
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
