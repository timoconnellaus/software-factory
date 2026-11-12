// The Claude account a run uses (ADR 0410). Accounts live on the runner host; the harness only
// learns which one a run gets: its config dir and, for a token account, the file the token is in.
// The launch script reads the token from that file just before `exec`, so no file the harness
// writes ever holds it, and every other model credential is unset first: exactly one reaches Claude.
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT } from "@software-factory/runner-contract";
import { shellQuote } from "./launch.ts";
import type { StatusLine } from "./status.ts";
import { projectDirName } from "./transcript.ts";

/** The variable a token goes in: a `claude setup-token` OAuth token, or an Anthropic API key. */
export const TOKEN_ENVS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
export type TokenEnv = (typeof TOKEN_ENVS)[number];

/**
 * Every variable Claude Code takes a model credential (or the config dir holding one) from. A run
 * on a named account starts with all of them unset, then gets its own.
 */
export const MODEL_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
] as const;

/** Where a Claude login keeps its credentials in its config dir when there's no Keychain (Linux). */
export const CREDENTIALS_FILE = ".credentials.json";

export interface HarnessAccount {
  /** The account's name on the host (`default`: whatever `claude` uses with no account set). */
  name: string;
  /** Its Claude config dir (`CLAUDE_CONFIG_DIR`). Absent for `default`. */
  configDir?: string;
  /** A token account: the 0600 file the token is in, and the variable it goes in. */
  token?: { file: string; env: TokenEnv };
}

/** The host's own account: the environment as it is. */
export const DEFAULT_HARNESS_ACCOUNT: HarnessAccount = { name: DEFAULT_ACCOUNT };

/** Whatever `claude` uses with no account set: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

/** The config dir a run on this account uses (where its transcripts go). */
export function accountConfigDir(
  account: HarnessAccount | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return account?.configDir ?? defaultClaudeConfigDir(env);
}

/**
 * The launch script's lines that give Claude the account. None for the default account (the
 * environment stays as the host has it, as before accounts existed).
 */
export function accountLaunchLines(account: HarnessAccount | undefined): string[] {
  if (!account?.configDir) return [];
  const lines = [
    `# Claude account "${account.name}" (ADR 0410): one model credential, nothing else.`,
    `unset ${MODEL_CREDENTIAL_ENV.join(" ")}`,
    `CLAUDE_CONFIG_DIR=${shellQuote(account.configDir)}`,
    "export CLAUDE_CONFIG_DIR",
  ];
  if (account.token) {
    const v = account.token.env;
    lines.push(
      `${v}="$(cat ${shellQuote(account.token.file)})" || exit 96`,
      `[ -n "$${v}" ] || exit 96`,
      `export ${v}`,
    );
  }
  return lines;
}

/**
 * A planning session resumed on another account than the one it started on (the owner switched in
 * between): copies its conversation into this account's config dir, where `claude --resume` looks.
 * Returns the file it copied from, or null when there was nothing to do.
 */
export async function carryConversation(options: {
  cwd: string;
  sessionId: string;
  to: string;
  from: readonly string[];
}): Promise<string | null> {
  const file = `${options.sessionId}.jsonl`;
  const project = projectDirName(options.cwd);
  const target = join(options.to, "projects", project, file);
  if (await isFile(target)) return null;
  for (const dir of options.from) {
    if (dir === options.to) continue;
    const source = join(dir, "projects", project, file);
    if (!(await isFile(source))) continue;
    await mkdir(join(options.to, "projects", project), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    return source;
  }
  return null;
}

const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/** What Claude says when an account is out of usage, in a hook message or a final reply. */
const USAGE_LIMIT =
  /usage limit|hit your (?:usage )?limit|limit reached|out of (?:extra )?usage|rate[ _-]?limit/i;

/**
 * The usage-limit message a status line carries, or null (ADR 0410: surfaced, never acted on by
 * switching). `StopFailure` reports Claude's API error type: `rate_limit` is the account's limit.
 */
export function usageLimitOf(line: Pick<StatusLine, "event" | "error" | "message">): string | null {
  if (line.event !== "StopFailure") return null;
  if (line.error === "rate_limit" || USAGE_LIMIT.test(line.message ?? "")) {
    return line.message?.trim() || "usage limit reached (rate_limit)";
  }
  return null;
}

/** Whether a final message is Claude saying the account hit its usage limit. */
export function isUsageLimitText(text: string | null | undefined): boolean {
  return !!text && text.length < 500 && USAGE_LIMIT.test(text);
}
