// runner-orca: the runner contract over the `orca` CLI (ADR 0014, 0100). A job becomes an Orca
// worktree on the run branch (tagged with an `sf-job:<jobId>` comment so capacity and cleanup
// survive a host restart), the Claude harness's per-run settings are projected into it, and Claude
// Code runs in an Orca terminal with the harness's own launch command (ADR 0270), so a person can
// take the run over in the Orca UI. The live process is checked against the launch record before
// the prompt is sent. Events come from
// polling `orca worktree ps` (agent state, tool, last message) and paging `orca terminal read`.
// Artifacts are the terminal screen, the check output from Claude's transcript and, with the
// browser capability, screenshots from Orca's embedded browser. Git (the diff, the push) is the
// runner host's job, not the adapter's.
import { access, appendFile, mkdir, readFile, realpath, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  attachmentsPrompt,
  type ClaudeHooks,
  checkOutputLog,
  findTranscript,
  HARNESS_CONFIG_MISMATCH,
  type LaunchRecord,
  PID_FILE,
  PRIVATE_WORKTREE_FILES,
  PROMPT_FILE,
  PROMPT_POINTER,
  projectHarness,
  type ReadCommand,
  readLaunchRecord,
  readTranscript,
  removeRunDir,
  shellQuote,
  verifyLaunch,
  writeAttachments,
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
  RESULT_FILE,
  type RunnerAdapter,
  type SessionHandle,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { type Exec, nodeExec, run } from "./exec.ts";
import { type OrcaAgentRow, OrcaCliError, type OrcaCliOptions, orcaCli } from "./orca-cli.ts";
import { findRepoForJob, JOB_COMMENT_PREFIX } from "./workspace.ts";

export { JOB_COMMENT_PREFIX };

export interface OrcaWorkspace extends WorkspaceHandle {
  worktreeId: string;
  repoId: string;
  repoPath: string;
  runDir: string;
  runTmp: string;
  /** What the harness must look like once launched (the harness's launch record). */
  launch: LaunchRecord;
  /** The harness's launch script, run with `/bin/sh` in the job's terminal. */
  launchScript: string;
  /** Where this run's attachments go: outside the worktree and the protected run dirs. */
  attachmentsDir: string;
}

export interface OrcaSession extends SessionHandle {
  handle: string;
  paneKey?: string;
  worktreeId: string;
  worktreePath: string;
  /** The harness's launch script; its pid file is next to it. */
  launchScript: string;
  startedAt: number;
}

export interface OrcaRunnerConfig extends OrcaCliOptions {
  maxConcurrent?: number;
  /**
   * The runner host's own clone of a job's repo. Used only when this machine's Orca has no repo for
   * the job's remote (ADR 0260): it is then registered once and kept.
   */
  resolveRepoPath: (job: Job) => Promise<string> | string;
  /**
   * Where the runner keeps its own clones. A repo under it loses to the owner's own checkout of the
   * same remote, and the startup migration retires it.
   */
  ownReposDir?: string;
  /**
   * Where the job's worktree starts (default `job.repo.baseRef`): a ref or a SHA in the checkout at
   * `repoPath`.
   */
  startPoint?: (job: Job, repoPath: string) => Promise<string> | string;
  /** Per-run private directories (git config, empty tool dirs) go under here. */
  runsDir: string;
  /**
   * Each run's attachments go under here, in `<jobId>/` (ADR 0310). Outside every worktree, and
   * not in `protectPaths`, so the harness can read them. Default: `attachments` next to `runsDir`.
   */
  attachmentsDir?: string;
  /** Absolute paths the harness must not read (the runner's key, the repo cache's .git). */
  protectPaths?: string[];
  /** Commit identity for the harness. */
  identity?: { name: string; email: string };
  /** The Orca agent id for the harness; V1 only has claude-code → "claude". */
  agent?: string;
  /** The `claude` executable the launch script runs (default `claude` on the terminal's PATH). */
  claudeBin?: string;
  /** How long Claude may take to come up in its terminal before the job fails. */
  startTimeoutMs?: number;
  /** The Node that runs a planning session's MCP server and hooks (default: this process's). */
  nodeBin?: string;
  /** Reads a live process's command line (default `ps`). Tests script it. */
  readCommand?: ReadCommand;
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
  "work-item-attachments",
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

/** A factory run branch (`factory/<n>-<slug>-run-<k>`, ADR 0035): the only kind the adapter deletes. */
export function isRunBranch(branch: string): boolean {
  return /^factory\/[0-9]+-[a-z0-9-]+-run-[0-9]+$/.test(branch);
}

/**
 * A worktree directory name for the job. A planning job's is its session's (ADR 0350): every job of
 * the session gets the same path, so `claude --resume` finds the conversation, which Claude keeps
 * by working directory.
 */
export function worktreeName(jobId: string, planningSessionId?: string): string {
  if (planningSessionId) {
    return `sf-plan-${planningSessionId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}`;
  }
  return `sf-${jobId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}`;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Orca's status hook, for a harness launched without the owner's user settings (where Orca keeps
 * its hooks). It reports to Orca over the env Orca gives every terminal, and is a no-op elsewhere.
 */
export const ORCA_STATUS_HOOK_COMMAND =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansions, not a template
  'if [ -n "${HOME-}" ] && [ -x "${HOME-}/.orca/agent-hooks/claude-hook.sh" ]; then ORCA_HOOK_AGENT_PID="${PPID:-}"; export ORCA_HOOK_AGENT_PID; /bin/sh "${HOME-}/.orca/agent-hooks/claude-hook.sh"; else printf \'{}\\n\'; fi';

/**
 * The events Orca's sidebar needs to show the run's state. Not PreToolUse, PermissionRequest or
 * Elicitation: Orca's hook can answer those, and the factory's settings decide permissions alone.
 */
export const ORCA_STATUS_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PostToolUse",
  "PostToolUseFailure",
  "SessionEnd",
] as const;

export function orcaStatusHooks(): ClaudeHooks {
  const hooks: ClaudeHooks = {};
  for (const event of ORCA_STATUS_HOOK_EVENTS) {
    hooks[event] = [
      { hooks: [{ type: "command", command: ORCA_STATUS_HOOK_COMMAND, timeout: 10 }] },
    ];
  }
  return hooks;
}

/** A job failed because its live harness isn't configured as the factory set it (ADR 0270). */
export class HarnessConfigMismatch extends Error {
  override name = "HarnessConfigMismatch";
  constructor(readonly problems: string[]) {
    super(`${HARNESS_CONFIG_MISMATCH}: ${problems.join("; ")}`);
  }
}

/** Claude's first-run folder trust dialog (Orca's `agent launch` pre-trusts; a plain terminal doesn't). */
const TRUST_DIALOG = /trust this folder/i;

/**
 * Checks a running job's harness against its launch record (for `sf-runner doctor`). Null when the
 * job has no launch record (not launched yet, or by an older runner).
 */
export async function checkRunningHarness(
  runDir: string,
  readCommand?: ReadCommand,
): Promise<{ record: LaunchRecord; problems: string[] } | null> {
  const record = await readLaunchRecord(runDir);
  if (!record) return null;
  return { record, problems: await verifyLaunch(record, readCommand) };
}

export function createOrcaRunner(
  config: OrcaRunnerConfig,
): RunnerAdapter<OrcaWorkspace, OrcaSession> {
  const exec = config.exec ?? nodeExec;
  const orca = orcaCli(config);
  const pollMs = config.pollMs ?? 2000;
  const agent = config.agent ?? "claude";
  const waitingInputTimeoutMs = config.waitingInputTimeoutMs ?? 15 * 60_000;
  const startTimeoutMs = config.startTimeoutMs ?? 90_000;
  const capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
  const ownership = {
    exec,
    ...(config.ownReposDir ? { ownReposDir: config.ownReposDir } : {}),
  };

  async function findAgent(session: OrcaSession): Promise<OrcaAgentRow | undefined> {
    const rows = await orca.worktreePs();
    const row = rows.find((r) => r.worktreeId === session.worktreeId);
    if (!row) return undefined;
    return (
      row.agents.find((a) => session.paneKey && a.paneKey === session.paneKey) ??
      row.agents.find((a) => a.agentType === agent)
    );
  }

  /** Claude is up in the job's own pane: its launch script ran and Orca sees an agent there. */
  async function isUp(session: OrcaSession): Promise<boolean> {
    if (!session.paneKey) return false;
    const pid = await readFile(join(dirname(session.launchScript), PID_FILE), "utf8").catch(
      () => "",
    );
    if (!pid.trim()) return false;
    const rows = await orca.worktreePs().catch(() => []);
    const row = rows.find((r) => r.worktreeId === session.worktreeId);
    return !!row?.agents.some((a) => a.paneKey === session.paneKey);
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
      // Only ever a factory run branch: the checkout may be the owner's own.
      await attempt("delete branch", async () => {
        if (!isRunBranch(workspace.branch)) return;
        const has = await exec(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`],
          { cwd: workspace.repoPath },
        );
        if (has.code === 0) {
          await run(exec, "git", ["branch", "-D", workspace.branch], { cwd: workspace.repoPath });
        }
      });
      await attempt("remove run dir", () => removeRunDir(workspace.runDir, workspace.runTmp));
      await attempt("remove attachments", () => removeRunDir(workspace.attachmentsDir));
      // The repo itself stays registered: it is the owner's project (or the runner's one permanent
      // clone), never a per-job registration (ADR 0260).
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

    async resolveCheckout(job): Promise<string | null> {
      return (await findRepoForJob(orca, job, ownership))?.path ?? null;
    },

    async prepareWorkspace(job, _signal, options): Promise<OrcaWorkspace> {
      if (job.stage === "planning" && !options?.planningRelay) {
        throw new Error(`planning job ${job.jobId} came without its relay`);
      }
      // ADR 0260: the Orca repo that already exists for the job's remote; only when there is none,
      // the host's clone, registered once and kept.
      let repo: { id: string; path: string } | null = await findRepoForJob(orca, job, ownership);
      if (!repo) {
        const clone = await realpath(await config.resolveRepoPath(job));
        // Registered already under another identity (no remote yet, say)? Reuse it by path.
        for (const r of await orca.repoList()) {
          if ((await realpath(r.path).catch(() => r.path)) === clone) repo = r;
        }
        repo ??= await orca.repoAdd(clone);
      }
      const repoPath = await realpath(repo.path).catch(() => repo.path);
      // A local branch left by a crashed run would make Orca suffix the name; the run branch is
      // this run's alone (ADR 0035), so a stale local copy can go. Only a factory run branch that
      // no worktree has checked out: never one of the owner's branches.
      const stale = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
      if (isRunBranch(job.branch) && !stale.stdout.includes(`branch refs/heads/${job.branch}\n`)) {
        await exec("git", ["branch", "-D", job.branch], { cwd: repoPath });
      }
      const worktree = await orca.worktreeCreate({
        repoId: repo.id,
        name: worktreeName(job.jobId, job.planning?.sessionId),
        branch: job.branch,
        baseRef: config.startPoint ? await config.startPoint(job, repoPath) : job.repo.baseRef,
        comment: `${JOB_COMMENT_PREFIX}${job.jobId}`,
      });
      const runDir = join(config.runsDir, job.jobId);
      const attachmentsDir = join(
        config.attachmentsDir ?? join(dirname(config.runsDir), "attachments"),
        job.jobId,
      );
      const workspace = {
        jobId: job.jobId,
        path: worktree.path,
        branch: worktree.branch.replace(/^refs\/heads\//, ""),
        baseSha: worktree.head,
        worktreeId: worktree.id,
        repoId: repo.id,
        repoPath,
        runDir,
        attachmentsDir,
      };
      if (workspace.branch !== job.branch) {
        // One branch per run: Orca picked another name, so this workspace can't be used.
        await release(
          job,
          { ...workspace, runTmp: "", launch: {} as LaunchRecord, launchScript: "" },
          undefined,
        ).catch(() => {});
        throw new Error(`Orca made branch ${workspace.branch}, not ${job.branch}`);
      }
      await excludePrivateFiles(worktree.path);
      // A linked worktree keeps its objects and refs in the checkout's git dir, outside the
      // worktree: the harness's sandbox must let the run's own git write there (and only there).
      const [commonDir = "", gitDir = ""] = (
        await run(
          exec,
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"],
          { cwd: worktree.path },
        )
      )
        .trim()
        .split("\n");
      const projected = await projectHarness(job, {
        worktree: worktree.path,
        runDir,
        // The checkout the worktree hangs off may be the owner's own: the harness reads only its
        // worktree, never the main checkout (its .env files, other branches' work).
        protectPaths: [...new Set([...(config.protectPaths ?? []), repoPath])],
        ...(commonDir && gitDir ? { git: { commonDir, gitDir } } : {}),
        ...(capabilities.includes("work-item-attachments") ? { attachmentsDir } : {}),
        // Orca keeps its status hooks in the owner's user settings, which a run doesn't load.
        hooks: orcaStatusHooks(),
        ...(config.identity ? { identity: config.identity } : {}),
        ...(config.claudeBin ? { claudeBin: config.claudeBin } : {}),
        ...(job.stage === "planning" && options?.planningRelay
          ? {
              planning: {
                relay: options.planningRelay,
                ...(config.nodeBin ? { nodeBin: config.nodeBin } : {}),
              },
            }
          : {}),
      });
      return {
        ...workspace,
        runTmp: projected.runTmp,
        launch: projected.launch,
        launchScript: projected.scriptPath,
      };
    },

    async attachFiles(_job, workspace, files): Promise<string> {
      if (!capabilities.includes("work-item-attachments")) return "";
      const written = await writeAttachments(workspace.attachmentsDir, files);
      return attachmentsPrompt(written, new Map(files.map((f) => [f.meta.id, f.bytes])));
    },

    async startSession(job, workspace, signal): Promise<OrcaSession> {
      // The harness's own command, not `orca agent launch` (which adds the owner's agent flags).
      const terminal = await orca.terminalCreate({
        worktreeId: workspace.worktreeId,
        title: `factory ${job.stage} ${job.workItem.number}`,
        command: `exec /bin/sh ${shellQuote(workspace.launchScript)}`,
      });
      const session: OrcaSession = {
        jobId: job.jobId,
        sessionRef: terminal.handle,
        handle: terminal.handle,
        ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
        worktreeId: workspace.worktreeId,
        worktreePath: workspace.path,
        launchScript: workspace.launchScript,
        startedAt: Date.now(),
        takeover: {
          label: "Open in Orca",
          hint: `orca worktree activate --worktree id:${workspace.worktreeId} && orca terminal switch --terminal ${terminal.handle}`,
        },
      };
      const fail = async (error: Error): Promise<never> => {
        await orca.terminalClose(terminal.handle).catch(() => {});
        throw error;
      };

      // Wait for Claude to come up: answer its first-run folder trust dialog for the job's own
      // worktree (once), and wait for Orca to see the agent in this pane.
      const deadline = Date.now() + startTimeoutMs;
      let trusted = false;
      for (;;) {
        if (signal.aborted) await fail(new Error(String(signal.reason ?? "cancelled")));
        const screen = await orca
          .terminalRead(terminal.handle, { screen: true })
          .then((r) => r.tail.join("\n"))
          .catch(() => "");
        if (TRUST_DIALOG.test(screen)) {
          if (trusted) await fail(new Error("Claude asked to trust the worktree twice"));
          await orca.terminalWrite(terminal.handle, "\u001b[B"); // "Yes, I trust this folder"
          await sleep(300);
          await orca.terminalWrite(terminal.handle, "\r");
          trusted = true;
        } else if (await isUp(session)) {
          break;
        }
        if (Date.now() > deadline) {
          await fail(
            new Error(
              `Claude did not start within ${Math.round(startTimeoutMs / 1000)} s:\n${screen.slice(-2_000)}`,
            ),
          );
        }
        await sleep(Math.min(pollMs, 1_000), undefined, { signal }).catch(() => {});
      }

      // Before the job does anything: the live process and its settings must be exactly what the
      // harness set. Otherwise kill it and fail the job (incident 2026-11-11 #6).
      const problems = await verifyLaunch(workspace.launch, config.readCommand);
      if (problems.length > 0) await fail(new HarnessConfigMismatch(problems));

      // The prompt goes in a file; the terminal gets one short line pointing at it. A long paste
      // into the Claude terminal arrives truncated (incident 2026-11-11 #8).
      await writeFile(join(workspace.path, PROMPT_FILE), job.harness.prompt, { mode: 0o600 });
      session.startedAt = Date.now();
      await orca.terminalPrompt(terminal.handle, PROMPT_POINTER).catch(async (err) => {
        await fail(new Error(`sending the prompt: ${err instanceof Error ? err.message : err}`));
      });
      return session;
    },

    async *events(job, session, signal): AsyncIterable<AdapterEvent> {
      // A planning session (ADR 0300) idles in its Stop hook between turns: `done` and idle are
      // normal there. It ends when the host stops it (a yield, the gate decided) or Claude exits.
      const planning = job.stage === "planning";
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
          if (!planning && status === "done" && (sawWorking || doneAfterLaunch)) {
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
          if (!planning && quietWithResult >= 3) {
            yield {
              type: "session.ended",
              outcome: "completed",
              ...(row.lastAssistantMessage ? { summary: row.lastAssistantMessage } : {}),
            };
            return;
          }
          if (status === "waiting_input" && !planning) {
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
          // What the run used, per model (spec 09 M3): counts only, never keys or bills.
          if (summary.usage.length > 0) {
            artifacts.push({
              kind: "usage",
              harness: "claude-code",
              entries: summary.usage,
              ...(summary.wallMs !== null ? { wallMs: summary.wallMs } : {}),
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
      await orca.terminalPrompt(session.handle, text);
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
