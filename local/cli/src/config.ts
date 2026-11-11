// The CLI's configuration and its token (spec 07). The token is a person's credential: it lives in a
// 0600 file in a 0700 directory, like the runner's key (local/runner-host/src/config.ts). Paths
// follow XDG on every platform. `SF_TOKEN`, `SF_URL` and `SF_APP_URL` override the file, so an agent
// session can be handed a read token without touching it.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";

/** The engine, which serves `/cli/v1`. */
export const DEFAULT_URL = "https://sf-engine.zerobsai.com";
/** The app, for links: work item pages, review packets, approving a login. */
export const DEFAULT_APP_URL = "https://software-factory.zerobsai.com";

export const SCOPES = ["read", "write"] as const;
export type Scope = (typeof SCOPES)[number];

export interface CliConfig {
  url?: string;
  appUrl?: string;
  token?: string | null;
  tokenId?: string | null;
  scope?: Scope | null;
  /** The GitHub login the token belongs to. */
  login?: string | null;
  expiresAt?: string | null;
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SF_CONFIG) return env.SF_CONFIG;
  const home = env.HOME ?? homedir();
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "software-factory", "cli.json");
}

const optionalString = (v: unknown): string | null | undefined =>
  typeof v === "string" ? v : v === null ? null : undefined;

/** The config on disk, or `{}` when there is none. A file that isn't ours is an error, not `{}`. */
export async function loadConfig(file: string): Promise<CliConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(
      "config",
      `${file} isn't valid JSON; fix it or delete it and run \`sf login\``,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError("config", `${file} isn't a JSON object; delete it and run \`sf login\``);
  }
  const r = raw as Record<string, unknown>;
  const scope = r.scope === "read" || r.scope === "write" ? r.scope : null;
  const config: CliConfig = {
    url: optionalString(r.url) ?? undefined,
    appUrl: optionalString(r.appUrl) ?? undefined,
    token: optionalString(r.token),
    tokenId: optionalString(r.tokenId),
    scope,
    login: optionalString(r.login),
    expiresAt: optionalString(r.expiresAt),
  };
  for (const key of Object.keys(config) as (keyof CliConfig)[]) {
    if (config[key] === undefined) delete config[key];
  }
  return config;
}

export async function saveConfig(file: string, config: CliConfig): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700).catch(() => {});
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode applies only when it creates the file.
  await chmod(file, 0o600);
}

/** Forget the token but keep where the factory is. Removes the file when nothing is left. */
export async function clearToken(file: string, config: CliConfig): Promise<void> {
  const rest: CliConfig = {};
  if (config.url) rest.url = config.url;
  if (config.appUrl) rest.appUrl = config.appUrl;
  if (Object.keys(rest).length === 0) await rm(file, { force: true });
  else await saveConfig(file, rest);
}

export interface Settings {
  url: string;
  appUrl: string;
  token: string | null;
  /** Where the token came from: `SF_TOKEN`, the config file, or nowhere. */
  tokenSource: "env" | "config" | null;
}

export function settings(config: CliConfig, env: NodeJS.ProcessEnv = process.env): Settings {
  const strip = (u: string) => u.replace(/\/+$/, "");
  const envToken = env.SF_TOKEN?.trim();
  const token = envToken || config.token || null;
  return {
    url: strip(env.SF_URL || config.url || DEFAULT_URL),
    appUrl: strip(env.SF_APP_URL || config.appUrl || DEFAULT_APP_URL),
    token,
    tokenSource: envToken ? "env" : config.token ? "config" : null,
  };
}
