// A thin, typed wrapper over the `orca` CLI (`--json`). Only the fields the adapter reads are
// typed; the CLI returns much more. Every call goes through `call`, which turns `{ ok: false }`
// into an OrcaCliError carrying Orca's error code.

import { type Exec, nodeExec } from "./exec.ts";

export class OrcaCliError extends Error {
  readonly command: string;
  readonly code: string;
  constructor(command: string, code: string, message: string) {
    super(`orca ${command}: ${code}: ${message}`);
    this.command = command;
    this.code = code;
  }
}

export interface OrcaRemoteIdentity {
  /** `github.com/<owner>/<repo>`, as Orca normalises the remote. */
  canonicalKey?: string;
  remoteName?: string;
  remoteUrl?: string;
}

export interface OrcaRepo {
  id: string;
  path: string;
  displayName: string;
  kind?: string;
  addedAt?: number;
  gitRemoteIdentity?: OrcaRemoteIdentity | null;
}

/** A durable Orca project: one remote identity, one or more source repos (checkouts). */
export interface OrcaProject {
  id: string;
  displayName: string;
  gitRemoteIdentity?: OrcaRemoteIdentity | null;
  sourceRepoIds?: string[];
}

export interface OrcaWorktree {
  id: string;
  repoId: string;
  path: string;
  /** `refs/heads/<name>` */
  branch: string;
  head: string;
  comment: string;
}

export interface OrcaTerminal {
  handle: string;
  paneKey?: string;
  processId?: number;
  worktreeId?: string;
}

export interface OrcaAgentRow {
  paneKey: string;
  state: string;
  agentType: string;
  lastAssistantMessage?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  stateStartedAt?: number;
  hasLivePty?: boolean;
  interrupted?: boolean;
}

export interface OrcaPsRow {
  worktreeId: string;
  repoId?: string;
  path: string;
  comment?: string;
  agents: OrcaAgentRow[];
  terminalVerdict?: string;
}

export interface OrcaTerminalRead {
  handle: string;
  status: string;
  tail: string[];
  nextCursor?: string;
  latestCursor?: string;
  oldestCursor?: string;
  limited?: boolean;
}

export interface OrcaCliOptions {
  /** The executable, e.g. "orca" or "orca-dev". */
  bin?: string;
  /** A paired Orca server to target instead of this machine's Orca. */
  environment?: string;
  exec?: Exec;
}

export function orcaCli(options: OrcaCliOptions = {}) {
  const bin = options.bin ?? "orca";
  const exec = options.exec ?? nodeExec;
  const env = options.environment ? ["--environment", options.environment] : [];

  async function call<T>(args: string[], timeoutMs = 120_000): Promise<T> {
    const command = args
      .filter((a) => !a.startsWith("-"))
      .slice(0, 2)
      .join(" ");
    const result = await exec(bin, [...args, ...env, "--json"], { timeoutMs });
    let parsed: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new OrcaCliError(command, "not_json", (result.stderr || result.stdout).trim());
    }
    if (!parsed.ok) {
      throw new OrcaCliError(
        command,
        parsed.error?.code ?? "unknown",
        parsed.error?.message ?? (result.stderr || "no message"),
      );
    }
    return parsed.result as T;
  }

  return {
    call,
    repoList: async () => (await call<{ repos: OrcaRepo[] }>(["repo", "list"])).repos,
    projectList: async () =>
      (await call<{ projects: OrcaProject[] }>(["project", "list"])).projects,
    repoAdd: async (path: string) =>
      (await call<{ repo: OrcaRepo }>(["repo", "add", "--path", path])).repo,
    /** There is no `repo rm`; a repo-backed project setup is removed with `project setup-delete`. */
    repoForget: (repoId: string) => call(["project", "setup-delete", "--setup", repoId, "--force"]),
    worktreeCreate: async (input: {
      repoId: string;
      name: string;
      branch: string;
      baseRef: string;
      comment: string;
    }) =>
      (
        await call<{ worktree: OrcaWorktree }>([
          "worktree",
          "create",
          "--repo",
          `id:${input.repoId}`,
          "--name",
          input.name,
          "--branch",
          input.branch,
          "--base-branch",
          input.baseRef,
          "--comment",
          input.comment,
          "--no-parent",
          "--setup",
          "skip",
        ])
      ).worktree,
    worktreeRemove: (worktreeId: string) =>
      call(["worktree", "rm", "--worktree", `id:${worktreeId}`, "--force"]),
    worktreePs: async () =>
      (await call<{ worktrees: OrcaPsRow[] }>(["worktree", "ps", "--limit", "10000"])).worktrees,
    /**
     * A visible terminal in the worktree running `command` (typed into the login shell). The runner
     * starts the harness this way, not with `agent launch`, which adds the owner's own agent flags
     * (incident 2026-11-11 bootstrap #6, ADR 0261).
     */
    terminalCreate: async (input: { worktreeId: string; title: string; command: string }) => {
      const result = await call<{ terminal: OrcaTerminal }>([
        "terminal",
        "create",
        "--worktree",
        `id:${input.worktreeId}`,
        "--title",
        input.title,
        "--command",
        input.command,
      ]);
      if (!result.terminal?.handle) {
        throw new OrcaCliError("terminal create", "no_handle", "no terminal handle");
      }
      return result.terminal;
    },
    terminalClose: (handle: string) => call(["terminal", "close", "--terminal", handle]),
    /** Writes text to the terminal as is: no Enter, control bytes pass through (dialog keys). */
    terminalWrite: (handle: string, text: string) =>
      call(["terminal", "send", "--terminal", handle, "--text", text]),
    /** Sends a prompt to the agent in the terminal and waits up to `waitSeconds` for its turn. */
    terminalPrompt: (handle: string, text: string, waitSeconds = 30) =>
      call(
        [
          "terminal",
          "send",
          "--terminal",
          handle,
          "--text",
          text,
          "--enter",
          "--wait-submit",
          String(waitSeconds),
        ],
        (waitSeconds + 60) * 1000,
      ),
    terminalRead: async (handle: string, opts: { cursor?: string; screen?: boolean } = {}) =>
      (
        await call<{ terminal: OrcaTerminalRead }>([
          "terminal",
          "read",
          "--terminal",
          handle,
          ...(opts.screen ? ["--screen"] : []),
          ...(opts.cursor ? ["--cursor", opts.cursor, "--limit", "1000"] : []),
        ])
      ).terminal,
    terminalCloseAll: (worktreeId: string) =>
      call(["terminal", "close", "--worktree", `id:${worktreeId}`, "--all"]),
    tabCreate: async (worktreeId: string, url: string) =>
      call<{ browserPageId: string }>([
        "tab",
        "create",
        "--url",
        url,
        "--worktree",
        `id:${worktreeId}`,
      ]),
    waitForLoad: (pageId: string) => call(["wait", "--page", pageId, "--load", "load"], 20_000),
    screenshot: (pageId: string) => call<unknown>(["screenshot", "--page", pageId]),
    tabClose: (pageId: string) => call(["tab", "close", "--page", pageId]),
  };
}

export type OrcaCli = ReturnType<typeof orcaCli>;
