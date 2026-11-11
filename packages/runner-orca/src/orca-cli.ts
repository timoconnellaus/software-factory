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

export interface OrcaLaunch {
  outcome: { kind: "terminal" | "structured"; handle: string; paneKey?: string };
  prompt?: { outcome: string };
  receipt?: { detail: string };
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
    agentLaunch: async (input: {
      worktreeId: string;
      agent: string;
      prompt: string;
      model?: string;
    }) => {
      const result = await call<{ launch?: OrcaLaunch } & Partial<OrcaLaunch>>([
        "agent",
        "launch",
        "--agent",
        input.agent,
        "--worktree",
        `id:${input.worktreeId}`,
        "--surface",
        "terminal",
        "--prompt",
        input.prompt,
        ...(input.model ? ["--model", input.model] : []),
      ]);
      const launch = result.launch ?? (result as OrcaLaunch);
      if (!launch.outcome?.handle) throw new OrcaCliError("agent launch", "no_handle", "no handle");
      return launch;
    },
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
    terminalSend: (handle: string, text: string) =>
      call(["terminal", "send", "--terminal", handle, "--text", text, "--enter"]),
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
