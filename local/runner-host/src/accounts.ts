// Claude accounts on this host (ADR 0410, spec 32). A host holds named accounts and one is active:
// new jobs take it when their workspace is prepared, running jobs keep theirs.
//
//   login  a Claude Code login in its own config dir (`CLAUDE_CONFIG_DIR`), under the data dir
//   token  a `claude setup-token` OAuth token or an API key in a 0600 file under the config dir
//          (which every run denies), plus a config dir of its own
//   default  always there: whatever `claude` uses with no account set
//
// The registry (`accounts.json`) holds the active name and each account's kind, never a secret.
// The factory only ever sees names; the owner switches here (`sf-runner account use`) or from the
// dashboard (`runner.account.use`, delivered as `account.use` on the heartbeat).
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultClaudeConfigDir,
  type HarnessAccount,
  readLaunchRecord,
  TOKEN_ENVS,
  type TokenEnv,
} from "@software-factory/harness-claude";
import {
  ACCOUNT_NAME,
  DEFAULT_ACCOUNT,
  type RunnerAccounts,
} from "@software-factory/runner-contract";
import { z } from "zod";
import type { Paths } from "./config.ts";

export type AccountPaths = Pick<Paths, "accountsFile" | "accountTokensDir" | "accountConfigsDir"> & {
  /** Where the host records each account's last usage limit (its own state, not the registry). */
  limitsFile: string;
};

export function accountPaths(dirs: Paths): AccountPaths {
  return {
    accountsFile: dirs.accountsFile,
    accountTokensDir: dirs.accountTokensDir,
    accountConfigsDir: dirs.accountConfigsDir,
    limitsFile: join(dirs.stateDir, "account-limits.json"),
  };
}

const registrySchema = z.object({
  active: z.string().regex(ACCOUNT_NAME).default(DEFAULT_ACCOUNT),
  accounts: z
    .record(
      z.string().regex(ACCOUNT_NAME),
      z.object({
        kind: z.enum(["login", "token"]),
        tokenEnv: z.enum(TOKEN_ENVS).optional(),
        addedAt: z.string(),
      }),
    )
    .default({}),
});
export type AccountRegistry = z.infer<typeof registrySchema>;

const limitsSchema = z.record(z.string(), z.object({ at: z.string(), message: z.string() }));
export type AccountLimits = z.infer<typeof limitsSchema>;

export interface AccountInfo {
  name: string;
  kind: "default" | "login" | "token";
  active: boolean;
  /** The Claude config dir runs on it use (the default account's is whatever `claude` uses). */
  configDir: string;
  tokenEnv?: TokenEnv;
  limit?: { at: string; message: string };
}

export class AccountError extends Error {
  override name = "AccountError";
}

/** Checks an account name: lower-case letters, digits and `-`, up to 32. */
export function checkAccountName(name: string): string {
  if (!ACCOUNT_NAME.test(name)) {
    throw new AccountError(
      `"${name}" isn't an account name: use lower-case letters, digits and -, up to 32 characters`,
    );
  }
  return name;
}

/** Which variable a token goes in, from its prefix; null when the prefix doesn't say. */
export function detectTokenEnv(token: string): TokenEnv | null {
  if (token.startsWith("sk-ant-oat")) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (token.startsWith("sk-ant-api")) return "ANTHROPIC_API_KEY";
  return null;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Writes a file 0600 by rename, so a reader never sees half of it. */
async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

export async function loadRegistry(p: AccountPaths): Promise<AccountRegistry> {
  return registrySchema.parse(await readJson(p.accountsFile));
}

async function saveRegistry(p: AccountPaths, registry: AccountRegistry): Promise<void> {
  await writePrivate(p.accountsFile, `${JSON.stringify(registry, null, 2)}\n`);
}

export async function loadLimits(p: AccountPaths): Promise<AccountLimits> {
  return limitsSchema.parse(await readJson(p.limitsFile).catch(() => ({})));
}

const tokenFile = (p: AccountPaths, name: string) => join(p.accountTokensDir, `${name}.token`);
export const accountConfigPath = (p: AccountPaths, name: string) => join(p.accountConfigsDir, name);

/** The harness's view of an account: its config dir and, for a token account, its token file. */
function harnessAccount(
  p: AccountPaths,
  name: string,
  entry: AccountRegistry["accounts"][string] | undefined,
): HarnessAccount {
  if (name === DEFAULT_ACCOUNT || !entry) return { name: DEFAULT_ACCOUNT };
  return {
    name,
    configDir: accountConfigPath(p, name),
    ...(entry.kind === "token"
      ? { token: { file: tokenFile(p, name), env: entry.tokenEnv ?? "CLAUDE_CODE_OAUTH_TOKEN" } }
      : {}),
  };
}

/**
 * The account a job prepared now uses. An active name the registry no longer has (edited by hand)
 * falls back to `default`, which is what this host did before it had accounts.
 */
export async function activeAccount(p: AccountPaths): Promise<HarnessAccount> {
  const registry = await loadRegistry(p);
  return harnessAccount(p, registry.active, registry.accounts[registry.active]);
}

export async function listAccounts(
  p: AccountPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccountInfo[]> {
  const registry = await loadRegistry(p);
  const limits = await loadLimits(p);
  const active = registry.accounts[registry.active] ? registry.active : DEFAULT_ACCOUNT;
  const info = (name: string, kind: AccountInfo["kind"], tokenEnv?: TokenEnv): AccountInfo => ({
    name,
    kind,
    active: name === active,
    configDir: name === DEFAULT_ACCOUNT ? defaultClaudeConfigDir(env) : accountConfigPath(p, name),
    ...(tokenEnv ? { tokenEnv } : {}),
    ...(limits[name] ? { limit: limits[name] } : {}),
  });
  return [
    info(DEFAULT_ACCOUNT, "default"),
    ...Object.entries(registry.accounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, e]) => info(name, e.kind, e.kind === "token" ? e.tokenEnv : undefined)),
  ];
}

/** What the heartbeat carries: names, the active one, recent usage limits. Never a credential. */
export async function accountsReport(p: AccountPaths): Promise<RunnerAccounts> {
  const list = await listAccounts(p);
  return {
    names: list.map((a) => a.name),
    active: list.find((a) => a.active)?.name ?? DEFAULT_ACCOUNT,
    limits: list.flatMap((a) =>
      a.limit ? [{ name: a.name, at: a.limit.at, message: a.limit.message.slice(0, 500) }] : [],
    ),
  };
}

/** Every account's config dir, where a resumed planning conversation may be. */
export async function accountConfigDirs(p: AccountPaths): Promise<string[]> {
  return (await listAccounts(p)).map((a) => a.configDir);
}

async function addEntry(
  p: AccountPaths,
  name: string,
  entry: AccountRegistry["accounts"][string],
): Promise<void> {
  checkAccountName(name);
  if (name === DEFAULT_ACCOUNT) throw new AccountError(`"${DEFAULT_ACCOUNT}" is always there`);
  const registry = await loadRegistry(p);
  if (registry.accounts[name]) throw new AccountError(`there is already an account "${name}"`);
  registry.accounts[name] = entry;
  await saveRegistry(p, registry);
}

async function makeConfigDir(p: AccountPaths, name: string): Promise<string> {
  const dir = accountConfigPath(p, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

/**
 * A login account: its own config dir (0700). The caller then runs `claude` with
 * `CLAUDE_CONFIG_DIR` set to it so the owner logs in there.
 */
export async function addLoginAccount(
  p: AccountPaths,
  name: string,
  now = new Date(),
): Promise<HarnessAccount> {
  checkAccountName(name);
  const registry = await loadRegistry(p);
  if (name === DEFAULT_ACCOUNT || registry.accounts[name]) {
    throw new AccountError(`there is already an account "${name}"`);
  }
  await makeConfigDir(p, name);
  await addEntry(p, name, { kind: "login", addedAt: now.toISOString() });
  return harnessAccount(p, name, { kind: "login", addedAt: now.toISOString() });
}

/**
 * A token account: the token in a 0600 file under the runner's config dir, and a config dir of its
 * own, seeded so Claude skips its first-run onboarding (and, for an API key, its "use this key?"
 * question, which Claude answers from the key's last 20 characters).
 */
export async function addTokenAccount(
  p: AccountPaths,
  name: string,
  token: string,
  options: { env?: TokenEnv; now?: Date } = {},
): Promise<HarnessAccount> {
  checkAccountName(name);
  const value = token.trim();
  if (!value || /\s/.test(value)) throw new AccountError("the token is empty or has spaces in it");
  const env = options.env ?? detectTokenEnv(value);
  if (!env) {
    throw new AccountError(
      "can't tell what kind of token this is: pass --oauth (claude setup-token) or --api-key",
    );
  }
  const registry = await loadRegistry(p);
  if (name === DEFAULT_ACCOUNT || registry.accounts[name]) {
    throw new AccountError(`there is already an account "${name}"`);
  }
  await mkdir(p.accountTokensDir, { recursive: true, mode: 0o700 });
  await chmod(p.accountTokensDir, 0o700);
  await writePrivate(tokenFile(p, name), `${value}\n`);
  const dir = await makeConfigDir(p, name);
  const seeded = {
    hasCompletedOnboarding: true,
    ...(env === "ANTHROPIC_API_KEY"
      ? { customApiKeyResponses: { approved: [value.slice(-20)], rejected: [] } }
      : {}),
  };
  await writePrivate(join(dir, ".claude.json"), `${JSON.stringify(seeded, null, 2)}\n`);
  const entry = { kind: "token" as const, tokenEnv: env, addedAt: (options.now ?? new Date()).toISOString() };
  await addEntry(p, name, entry);
  return harnessAccount(p, name, entry);
}

/** Makes an account the active one: jobs prepared from now on use it. */
export async function useAccount(p: AccountPaths, name: string): Promise<void> {
  checkAccountName(name);
  const registry = await loadRegistry(p);
  if (name !== DEFAULT_ACCOUNT && !registry.accounts[name]) {
    throw new AccountError(`no account "${name}" (sf-runner account list)`);
  }
  if (registry.active === name) return;
  registry.active = name;
  await saveRegistry(p, registry);
}

/**
 * The accounts running jobs use, from their launch records (`<runsDir>/<jobId>/launch.json`), so
 * one that is in use is never removed under a job.
 */
export async function accountsInUse(runsDir: string, jobs: Iterable<string>): Promise<Set<string>> {
  const used = new Set<string>();
  for (const jobId of jobs) {
    const record = await readLaunchRecord(join(runsDir, jobId));
    if (record?.account) used.add(record.account);
  }
  return used;
}

/** Removes an account: its registry entry, its token file and its config dir. */
export async function removeAccount(
  p: AccountPaths,
  name: string,
  inUse: ReadonlySet<string> = new Set(),
): Promise<void> {
  checkAccountName(name);
  if (name === DEFAULT_ACCOUNT) throw new AccountError(`"${DEFAULT_ACCOUNT}" can't be removed`);
  const registry = await loadRegistry(p);
  if (!registry.accounts[name]) throw new AccountError(`no account "${name}"`);
  if (registry.active === name) {
    throw new AccountError(`"${name}" is the active account: sf-runner account use another first`);
  }
  if (inUse.has(name)) throw new AccountError(`a running job uses "${name}": wait for it to finish`);
  delete registry.accounts[name];
  await saveRegistry(p, registry);
  await rm(tokenFile(p, name), { force: true });
  await rm(accountConfigPath(p, name), { recursive: true, force: true });
  const limits = await loadLimits(p);
  if (limits[name]) {
    delete limits[name];
    await writePrivate(p.limitsFile, `${JSON.stringify(limits, null, 2)}\n`);
  }
}

/**
 * Records how a run on an account ended: the usage-limit message, or null for a run that ended
 * without one (which clears it). Surfaced on the heartbeat; nothing switches on its own.
 */
export async function noteUsage(
  p: AccountPaths,
  name: string,
  limit: string | null,
  now = new Date(),
): Promise<void> {
  const limits = await loadLimits(p);
  if (limit === null) {
    if (!limits[name]) return;
    delete limits[name];
  } else {
    limits[name] = { at: now.toISOString(), message: limit.slice(0, 500) };
  }
  await writePrivate(p.limitsFile, `${JSON.stringify(limits, null, 2)}\n`);
}

/** The environment `claude` gets to log a login account in: its config dir, no other credential. */
export function loginEnv(
  account: HarnessAccount,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    delete env[name];
  }
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

/** Who a login account's config dir is logged in as, if Claude recorded it. */
export async function loggedInAs(configDir: string): Promise<string | null> {
  const config = (await readJson(join(configDir, ".claude.json")).catch(() => ({}))) as {
    oauthAccount?: { emailAddress?: string };
  };
  return config.oauthAccount?.emailAddress ?? null;
}

