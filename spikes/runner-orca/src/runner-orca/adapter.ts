// runner-orca: the runner contract over the `orca` CLI. A job becomes an Orca worktree (tagged
// with an `sf-job:<jobId>` comment so capacity survives a host restart), Claude Code runs in an
// Orca terminal there (so a person can take it over in the Orca UI), events come from polling
// `orca worktree ps` (agent state, tool, last message) and paging `orca terminal read`, and
// artifacts are the git diff, the terminal log and, with the browser capability, screenshots from
// Orca's embedded browser.

import { readFile, realpath, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AdapterEvent,
  type AgentStatus,
  type Artifact,
  type Capability,
  type CapabilityManifest,
  type Capacity,
  CONTRACT_VERSION,
  type RunnerAdapter,
  type SessionHandle,
  type WorkspaceHandle,
} from "../contract/types.ts";
import { type Exec, nodeExec } from "../host/exec.ts";
import { collectDiff, deleteBranch } from "../host/git.ts";
import { type OrcaAgentRow, OrcaCliError, type OrcaCliOptions, orcaCli } from "./orca-cli.ts";

export const JOB_COMMENT_PREFIX = "sf-job:";

export interface OrcaWorkspace extends WorkspaceHandle {
  worktreeId: string;
  repoId: string;
  repoPath: string;
}

export interface OrcaSession extends SessionHandle {
  handle: string;
  paneKey?: string;
  worktreeId: string;
  startedAt: number;
}

export interface OrcaRunnerConfig extends OrcaCliOptions {
  maxConcurrent?: number;
  /** Maps a job's repo URL to a local checkout Orca can register. */
  resolveRepoPath: (repoUrl: string) => Promise<string> | string;
  /** The Orca agent id for the harness; v1 only has claude-code → "claude". */
  agent?: string;
  pollMs?: number;
  /** Capabilities to declare. Defaults to everything Orca's desktop app gives. */
  capabilities?: Capability[];
  exec?: Exec;
}

const DEFAULT_CAPABILITIES: Capability[] = [
  "browser",
  "ui-takeover",
  "auto-register",
  "hooks",
  "own-hardware",
];

/** Orca agent states → contract statuses. Unknown states are reported as idle with the raw name. */
export function agentStatus(state: string): AgentStatus {
  if (state === "working") return "working";
  if (state === "done") return "done";
  if (state === "idle") return "idle";
  if (/wait|permission|input|blocked|question/i.test(state)) return "waiting_input";
  if (/error|fail/i.test(state)) return "error";
  return "idle";
}

/** The screenshot result's file path; the field name isn't documented, so look for any image path. */
function findImagePath(value: unknown): string | undefined {
  if (typeof value === "string") return /\.(png|jpe?g)$/.test(value) ? value : undefined;
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const found = findImagePath(v);
      if (found) return found;
    }
  }
  return undefined;
}

/** Orca branch names must be safe for a worktree directory name too. */
function worktreeName(jobId: string): string {
  return `sf-${jobId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}`;
}

export function createOrcaRunner(
  config: OrcaRunnerConfig,
): RunnerAdapter<OrcaWorkspace, OrcaSession> {
  const exec = config.exec ?? nodeExec;
  const orca = orcaCli(config);
  const pollMs = config.pollMs ?? 2000;
  const agent = config.agent ?? "claude";
  /** Repos this runner registered in Orca, to unregister when its last job is released. */
  const addedRepos = new Set<string>();

  async function findAgent(session: OrcaSession): Promise<OrcaAgentRow | undefined> {
    const rows = await orca.worktreePs();
    const row = rows.find((r) => r.worktreeId === session.worktreeId);
    if (!row) return undefined;
    return (
      row.agents.find((a) => session.paneKey && a.paneKey === session.paneKey) ??
      row.agents.find((a) => a.agentType === agent)
    );
  }

  async function screenshot(worktreeId: string, url: string): Promise<Artifact> {
    const { browserPageId } = await orca.tabCreate(worktreeId, url);
    try {
      await orca.waitForLoad(browserPageId).catch(() => sleep(1500));
      const shot = await orca.screenshot(browserPageId);
      const path = findImagePath(shot);
      if (!path) throw new Error(`orca screenshot returned no image path: ${JSON.stringify(shot)}`);
      return {
        kind: "screenshot",
        name: new URL(url).pathname.split("/").pop() || "page",
        url,
        contentType: "image/png",
        base64: (await readFile(path)).toString("base64"),
      };
    } finally {
      await orca.tabClose(browserPageId).catch(() => {});
    }
  }

  return {
    async manifest(): Promise<CapabilityManifest> {
      return {
        contractVersion: CONTRACT_VERSION,
        runnerKind: "orca",
        harnesses: ["claude-code"],
        capabilities: config.capabilities ?? DEFAULT_CAPABILITIES,
      };
    },

    async capacity(): Promise<Capacity> {
      const rows = await orca.worktreePs();
      const inUse = rows.filter((r) => r.comment?.startsWith(JOB_COMMENT_PREFIX)).length;
      return { max: config.maxConcurrent ?? 4, inUse, accepting: true };
    },

    async prepareWorkspace(job): Promise<OrcaWorkspace> {
      const repoPath = await realpath(await config.resolveRepoPath(job.repo.url));
      const repos = await orca.repoList();
      let repo = undefined as (typeof repos)[number] | undefined;
      for (const r of repos) {
        if ((await realpath(r.path).catch(() => r.path)) === repoPath) repo = r;
      }
      if (!repo) {
        repo = await orca.repoAdd(repoPath);
        addedRepos.add(repo.id);
      }
      const worktree = await orca.worktreeCreate({
        repoId: repo.id,
        name: worktreeName(job.jobId),
        branch: job.branch,
        baseRef: job.repo.baseRef,
        comment: `${JOB_COMMENT_PREFIX}${job.jobId}`,
      });
      return {
        jobId: job.jobId,
        path: worktree.path,
        // Orca suffixes a taken branch name, so report the branch it actually made.
        branch: worktree.branch.replace(/^refs\/heads\//, ""),
        baseSha: worktree.head,
        worktreeId: worktree.id,
        repoId: repo.id,
        repoPath,
      };
    },

    async startSession(job, workspace): Promise<OrcaSession> {
      const startedAt = Date.now();
      const launch = await orca.agentLaunch({
        worktreeId: workspace.worktreeId,
        agent,
        prompt: job.harness.prompt,
        ...(job.harness.model ? { model: job.harness.model } : {}),
      });
      return {
        jobId: job.jobId,
        sessionRef: launch.outcome.handle,
        handle: launch.outcome.handle,
        ...(launch.outcome.paneKey ? { paneKey: launch.outcome.paneKey } : {}),
        worktreeId: workspace.worktreeId,
        startedAt,
        takeover: {
          label: "Open in Orca",
          hint: `orca worktree activate --worktree id:${workspace.worktreeId} && orca terminal switch --terminal ${launch.outcome.handle}`,
        },
      };
    },

    async *events(_job, session, signal): AsyncIterable<AdapterEvent> {
      let lastStatus: string | undefined;
      let lastTool: string | undefined;
      let cursor: string | undefined;
      let sawWorking = false;
      while (!signal.aborted) {
        // Terminal output since the last read, as log lines. Page with nextCursor from line 0;
        // latestCursor is the end of retained output, not a paging token.
        try {
          let limited = true;
          while (limited) {
            const read = await orca.terminalRead(session.handle, { cursor: cursor ?? "0" });
            if (read.tail.length > 0) {
              yield { type: "log", stream: "terminal", text: read.tail.join("\n") };
            }
            limited = !!read.limited && !!read.nextCursor && read.nextCursor !== read.latestCursor;
            cursor = read.nextCursor ?? cursor;
          }
        } catch (err) {
          if (err instanceof OrcaCliError && /stale|not_found/.test(err.code)) {
            yield { type: "session.ended", outcome: "failed", summary: "terminal went away" };
            return;
          }
        }

        const row = await findAgent(session);
        if (row) {
          const status = agentStatus(row.state);
          if (row.state !== lastStatus) {
            lastStatus = row.state;
            yield {
              type: "agent.status",
              status,
              ...(status === "idle" && row.state !== "idle" ? { message: row.state } : {}),
            };
          }
          const tool = row.toolName ? `${row.toolName}:${row.toolInput ?? ""}` : undefined;
          if (tool && tool !== lastTool) {
            lastTool = tool;
            yield {
              type: "tool",
              name: row.toolName ?? "",
              ...(row.toolInput ? { input: row.toolInput } : {}),
            };
          }
          if (status === "working") sawWorking = true;
          // `done` from before our prompt landed would end the job early; require that the agent
          // was seen working, or that its done state started after the launch.
          const doneAfterLaunch = (row.stateStartedAt ?? 0) >= session.startedAt;
          if (status === "done" && (sawWorking || doneAfterLaunch)) {
            yield {
              type: "session.ended",
              outcome: row.interrupted ? "cancelled" : "completed",
              ...(row.lastAssistantMessage ? { summary: row.lastAssistantMessage } : {}),
            };
            return;
          }
          if (row.hasLivePty === false) {
            yield {
              type: "session.ended",
              outcome: "failed",
              summary: "the agent's terminal exited",
            };
            return;
          }
        }
        await sleep(pollMs, undefined, { signal }).catch(() => {});
      }
      const reason = String(signal.reason ?? "");
      yield {
        type: "session.ended",
        outcome: reason.includes("timeout") ? "timed_out" : "cancelled",
      };
    },

    async collectArtifacts(job, workspace, session): Promise<Artifact[]> {
      const artifacts: Artifact[] = [
        await collectDiff(exec, workspace.path, workspace.baseSha, workspace.branch),
      ];
      if (session) {
        const screen = await orca.terminalRead(session.handle, { screen: true }).catch(() => null);
        if (screen)
          artifacts.push({ kind: "log", name: "terminal-screen", text: screen.tail.join("\n") });
      }
      const canBrowse = (config.capabilities ?? DEFAULT_CAPABILITIES).includes("browser");
      for (const url of canBrowse ? (job.evidence?.screenshotUrls ?? []) : []) {
        try {
          artifacts.push(await screenshot(workspace.worktreeId, url));
        } catch (err) {
          // Evidence is best effort: a failed screenshot is reported, it doesn't fail the job.
          const text = err instanceof Error ? err.message : String(err);
          artifacts.push({ kind: "log", name: `screenshot-error ${url}`, text });
        }
      }
      return artifacts;
    },

    async release(_job, workspace, session): Promise<void> {
      const errors: string[] = [];
      const attempt = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (err) {
          // Already gone is fine: release must be safe to call twice.
          if (err instanceof OrcaCliError && /not_found|no_match|unknown/.test(err.code)) return;
          errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
        }
      };
      const worktreeId = workspace?.worktreeId ?? session?.worktreeId;
      if (worktreeId) {
        await attempt("close terminals", () => orca.terminalCloseAll(worktreeId));
        await attempt("remove worktree", () => orca.worktreeRemove(worktreeId));
      }
      if (workspace) {
        // Orca leaves the per-repo parent folder (~/orca/workspaces/<repo>/) behind, even when
        // empty. rmdir only succeeds on an empty folder, so other worktrees are never touched.
        await rmdir(dirname(workspace.path)).catch(() => {});
        // The local branch always goes: the diff artifact (or, later, the pushed PR branch) is the record.
        await attempt("delete branch", () =>
          deleteBranch(exec, workspace.repoPath, workspace.branch),
        );
        if (addedRepos.has(workspace.repoId)) {
          const stillUsed = (await orca.worktreePs()).some(
            (r) => r.repoId === workspace.repoId && r.comment?.startsWith(JOB_COMMENT_PREFIX),
          );
          if (!stillUsed) {
            await attempt("unregister repo", () => orca.repoForget(workspace.repoId));
            addedRepos.delete(workspace.repoId);
          }
        }
      }
      if (errors.length > 0) throw new Error(errors.join("; "));
    },

    async steer(session, text) {
      await orca.terminalSend(session.handle, text);
    },
  };
}
