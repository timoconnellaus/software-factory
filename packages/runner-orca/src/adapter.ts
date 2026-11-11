// runner-orca: the runner contract over the `orca` CLI (ADR 0014, 0100). A job becomes an Orca
// worktree on the run branch (tagged with an `sf-job:<jobId>` comment so capacity and cleanup
// survive a host restart), the Claude harness's per-run settings are projected into it, and Claude
// Code runs in an Orca terminal, so a person can take the run over in the Orca UI. Events come from
// polling `orca worktree ps` (agent state, tool, last message) and paging `orca terminal read`.
// Artifacts are the terminal screen, the check output from Claude's transcript and, with the
// browser capability, screenshots from Orca's embedded browser. Git (the diff, the push) is the
// runner host's job, not the adapter's.
import { access, appendFile, mkdir, readFile, realpath, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  checkOutputLog,
  findTranscript,
  type PermissionMode,
  PRIVATE_WORKTREE_FILES,
  projectHarness,
  readTranscript,
  removeRunDir,
} from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  type AgentStatus,
  type Artifact,
  type Capability,
  type CapabilityManifest,
  type Capacity,
  CONTRACT_VERSION,
  type Job,
  type JobStage,
  RESULT_FILE,
  type RunnerAdapter,
  type SessionHandle,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { type Exec, nodeExec, run } from "./exec.ts";
import { type OrcaAgentRow, OrcaCliError, type OrcaCliOptions, orcaCli } from "./orca-cli.ts";

export const JOB_COMMENT_PREFIX = "sf-job:";

export interface OrcaWorkspace extends WorkspaceHandle {
  worktreeId: string;
  repoId: string;
  repoPath: string;
  runDir: string;
}

export interface OrcaSession extends SessionHandle {
  handle: string;
  paneKey?: string;
  worktreeId: string;
  worktreePath: string;
  startedAt: number;
}

export interface OrcaRunnerConfig extends OrcaCliOptions {
  maxConcurrent?: number;
  /** The local checkout Orca registers for a job's repo (the runner host's clone). */
  resolveRepoPath: (job: Job) => Promise<string> | string;
  /** Where the job's worktree starts (default `job.repo.baseRef`): a ref or a SHA in that checkout. */
  startPoint?: (job: Job) => Promise<string> | string;
  /** Per-run private directories (git config, empty tool dirs) go under here. */
  runsDir: string;
  /** Absolute paths the harness must not read (the runner's key, the repo cache's .git). */
  protectPaths?: string[];
  /** Permission mode per stage, overriding the harness defaults. */
  permissionMode?: Partial<Record<JobStage, PermissionMode>>;
  /** Commit identity for the harness. */
  identity?: { name: string; email: string };
  /** The Orca agent id for the harness; V1 only has claude-code → "claude". */
  agent?: string;
  pollMs?: number;
  /** A session waiting on a person this long fails (it can be taken over before then). */
  waitingInputTimeoutMs?: number;
  /** Capabilities to declare. Defaults to everything Orca's desktop app gives. */
  capabilities?: Capability[];
  exec?: Exec;
}

export const DEFAULT_CAPABILITIES: Capability[] = [
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

/** A worktree directory name for the job. */
export function worktreeName(jobId: string): string {
  return `sf-${jobId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}`;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function createOrcaRunner(
  config: OrcaRunnerConfig,
): RunnerAdapter<OrcaWorkspace, OrcaSession> {
  const exec = config.exec ?? nodeExec;
  const orca = orcaCli(config);
  const pollMs = config.pollMs ?? 2000;
  const agent = config.agent ?? "claude";
  const waitingInputTimeoutMs = config.waitingInputTimeoutMs ?? 15 * 60_000;
  const capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
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

  /** Keeps the harness's own files out of git in every worktree of the checkout. */
  async function excludePrivateFiles(worktree: string) {
    const path = (
      await run(
        exec,
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
        {
          cwd: worktree,
        },
      )
    ).trim();
    const current = await readFile(path, "utf8").catch(() => "");
    const missing = PRIVATE_WORKTREE_FILES.filter((f) => !current.split("\n").includes(`/${f}`));
    if (missing.length === 0) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${current.endsWith("\n") || !current ? "" : "\n"}${missing.map((f) => `/${f}`).join("\n")}\n`,
    );
  }

  async function release(
    _job: Job,
    workspace: OrcaWorkspace | undefined,
    session: OrcaSession | undefined,
  ): Promise<void> {
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
      // The local branch always goes: the pushed run branch (or the diff artifact) is the record.
      await attempt("delete branch", async () => {
        const has = await exec(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`],
          { cwd: workspace.repoPath },
        );
        if (has.code === 0) {
          await run(exec, "git", ["branch", "-D", workspace.branch], { cwd: workspace.repoPath });
        }
      });
      await attempt("remove run dir", () => removeRunDir(workspace.runDir));
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
  }

  return {
    async manifest(): Promise<CapabilityManifest> {
      return {
        contractVersion: CONTRACT_VERSION,
        runnerKind: "orca",
        harnesses: ["claude-code"],
        capabilities,
      };
    },

    async capacity(): Promise<Capacity> {
      const rows = await orca.worktreePs();
      const inUse = rows.filter((r) => r.comment?.startsWith(JOB_COMMENT_PREFIX)).length;
      return { max: config.maxConcurrent ?? 2, inUse, accepting: true };
    },

    async prepareWorkspace(job): Promise<OrcaWorkspace> {
      const repoPath = await realpath(await config.resolveRepoPath(job));
      const repos = await orca.repoList();
      let repo: (typeof repos)[number] | undefined;
      for (const r of repos) {
        if ((await realpath(r.path).catch(() => r.path)) === repoPath) repo = r;
      }
      if (!repo) {
        repo = await orca.repoAdd(repoPath);
        addedRepos.add(repo.id);
      }
      // A local branch left by a crashed run would make Orca suffix the name; the run branch is
      // this run's alone (ADR 0035), so a stale local copy can go.
      const stale = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
      if (!stale.stdout.includes(`branch refs/heads/${job.branch}\n`)) {
        await exec("git", ["branch", "-D", job.branch], { cwd: repoPath });
      }
      const worktree = await orca.worktreeCreate({
        repoId: repo.id,
        name: worktreeName(job.jobId),
        branch: job.branch,
        baseRef: config.startPoint ? await config.startPoint(job) : job.repo.baseRef,
        comment: `${JOB_COMMENT_PREFIX}${job.jobId}`,
      });
      const runDir = join(config.runsDir, job.jobId);
      const workspace: OrcaWorkspace = {
        jobId: job.jobId,
        path: worktree.path,
        branch: worktree.branch.replace(/^refs\/heads\//, ""),
        baseSha: worktree.head,
        worktreeId: worktree.id,
        repoId: repo.id,
        repoPath,
        runDir,
      };
      if (workspace.branch !== job.branch) {
        // One branch per run: Orca picked another name, so this workspace can't be used.
        await release(job, workspace, undefined).catch(() => {});
        throw new Error(`Orca made branch ${workspace.branch}, not ${job.branch}`);
      }
      await excludePrivateFiles(worktree.path);
      await projectHarness(job, {
        worktree: worktree.path,
        runDir,
        protectPaths: config.protectPaths ?? [],
        ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
        ...(config.identity ? { identity: config.identity } : {}),
      });
      return workspace;
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
        worktreePath: workspace.path,
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
      let waitingSince: number | null = null;
      let quietWithResult = 0;
      const resultPath = join(session.worktreePath, RESULT_FILE);
      while (!signal.aborted) {
        // Terminal output since the last read, as log lines. Page with nextCursor from line 0;
        // latestCursor is the end of retained output, not a paging token.
        try {
          let limited = true;
          while (limited) {
            const read = await orca.terminalRead(session.handle, { cursor: cursor ?? "0" });
            if (read.tail.length > 0) {
              yield { type: "log", stream: "terminal", text: clip(read.tail.join("\n"), 60_000) };
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

        const row = await findAgent(session).catch(() => undefined);
        const hasResult = await exists(resultPath);
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
              ...(row.toolInput ? { input: clip(row.toolInput, 7_000) } : {}),
            };
          }
          if (status === "working") sawWorking = true;
          // A `done` from before our prompt landed would end the job early: require that the agent
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
          // The result file is written last; once it exists and the agent has stopped working for
          // a few polls, the turn is over even if Orca never reported `done`.
          quietWithResult = hasResult && status !== "working" ? quietWithResult + 1 : 0;
          if (quietWithResult >= 3) {
            yield {
              type: "session.ended",
              outcome: "completed",
              ...(row.lastAssistantMessage ? { summary: row.lastAssistantMessage } : {}),
            };
            return;
          }
          if (status === "waiting_input") {
            waitingSince ??= Date.now();
            if (Date.now() - waitingSince > waitingInputTimeoutMs) {
              yield {
                type: "session.ended",
                outcome: "failed",
                summary: `the agent waited for input for over ${Math.round(waitingInputTimeoutMs / 60_000)} min (${row.state})`,
              };
              return;
            }
          } else {
            waitingSince = null;
          }
          if (row.hasLivePty === false) {
            yield {
              type: "session.ended",
              outcome: hasResult ? "completed" : "failed",
              summary: hasResult
                ? "the agent exited after writing its result"
                : "the agent's terminal exited",
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
      const artifacts: Artifact[] = [];
      if (session) {
        const screen = await orca.terminalRead(session.handle, { screen: true }).catch(() => null);
        if (screen) {
          artifacts.push({ kind: "log", name: "terminal-screen", text: screen.tail.join("\n") });
        }
        const transcript = await findTranscript(workspace.path, {
          since: session.startedAt - 60_000,
        }).catch(() => null);
        if (transcript) {
          const summary = await readTranscript(transcript);
          const checks = checkOutputLog(summary);
          if (checks) artifacts.push({ kind: "log", name: "check-output", text: checks });
          if (summary.lastAssistantText) {
            artifacts.push({
              kind: "log",
              name: "agent-final-message",
              text: summary.lastAssistantText,
            });
          }
        }
      }
      for (const url of capabilities.includes("browser")
        ? (job.evidence?.screenshotUrls ?? [])
        : []) {
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

    release,

    async steer(session, text) {
      await orca.terminalSend(session.handle, text);
    },
  };
}

/**
 * After a host crash: closes and removes Orca worktrees tagged `sf-job:<id>` for jobs the host is no
 * longer running. Returns the job ids it cleaned up. The cloud fails those runs on its own once their
 * leases lapse (ADR 0035).
 */
export async function reapOrphanWorktrees(
  options: OrcaCliOptions,
  running: Set<string>,
): Promise<string[]> {
  const orca = orcaCli(options);
  const reaped: string[] = [];
  for (const row of await orca.worktreePs()) {
    const jobId = row.comment?.startsWith(JOB_COMMENT_PREFIX)
      ? row.comment.slice(JOB_COMMENT_PREFIX.length)
      : null;
    if (!jobId || running.has(jobId)) continue;
    await orca.terminalCloseAll(row.worktreeId).catch(() => {});
    await orca.worktreeRemove(row.worktreeId).catch(() => {});
    await rmdir(dirname(row.path)).catch(() => {});
    reaped.push(jobId);
  }
  return reaped;
}
