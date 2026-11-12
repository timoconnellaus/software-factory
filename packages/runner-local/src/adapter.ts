// runner-local: the runner contract over plain git and tmux (ADR 0014, 0380). A job becomes a git
// worktree on the run branch, inside the checkout this machine already has for the repo (ADR 0260,
// amended), and Claude Code runs harness-claude's own launch script (ADR 0270) in a tmux session on
// the factory's own socket (`tmux -L software-factory`), so a person can `tmux attach` to take the
// run over. The live process is checked against the launch record before the prompt is sent.
// Agent status comes from the factory's status hook (`<runDir>/status.jsonl`), not the screen;
// terminal output streams from `capture-pane`, and what the agent says from its transcript (ADR
// 0400). Git (the diff, the push) is the runner host's job.
import { appendFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  attachmentsPrompt,
  checkOutputLog,
  findTranscript,
  HARNESS_CONFIG_MISMATCH,
  type LaunchRecord,
  PID_FILE,
  PRIVATE_WORKTREE_FILES,
  PROMPT_FILE,
  PROMPT_POINTER,
  parseStatusLines,
  projectHarness,
  type ReadCommand,
  readLaunchRecord,
  readStatusFrom,
  readTranscript,
  readTranscriptFrom,
  removeRunDir,
  STATUS_FILE,
  type StatusLine,
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
  MESSAGE_MAX,
  RESULT_FILE,
  type RunnerAdapter,
  type SessionHandle,
  steerText,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { exists, findCheckout, isUnder } from "./checkouts.ts";
import { type Exec, nodeExec, run } from "./exec.ts";
import {
  attachCommand,
  type PaneState,
  SESSION_PREFIX,
  sessionName,
  type TmuxOptions,
  tmuxCli,
} from "./tmux.ts";

export interface LocalWorkspace extends WorkspaceHandle {
  /** The checkout the worktree hangs off (the owner's own, or the host's clone). */
  checkout: string;
  /** `sf-<jobId>`: the worktree's directory name and the tmux session's name. */
  name: string;
  runDir: string;
  runTmp: string;
  /** What the harness must look like once launched (the harness's launch record). */
  launch: LaunchRecord;
  /** The harness's launch script, run with `/bin/sh` in the job's tmux session. */
  launchScript: string;
  /** Where the status hook appends its lines. */
  statusFile: string;
  /** Where this run's attachments go: outside the worktree and the protected run dirs. */
  attachmentsDir: string;
}

export interface LocalSession extends SessionHandle {
  /** The tmux session (`sf-<jobId>`). */
  name: string;
  worktreePath: string;
  runDir: string;
  statusFile: string;
  /** The harness's launch script; its pid file is next to it. */
  launchScript: string;
  startedAt: number;
  /** When the prompt pointer was sent: only a turn submitted after it can end the job. */
  promptSentAt: number;
}

export interface LocalRunnerConfig {
  maxConcurrent?: number;
  /**
   * Directories whose immediate git repos are the owner's checkouts (`runner.json` `checkouts`). A
   * job runs as a worktree of the one whose `origin` is the job's repo (ADR 0260, amended).
   */
  checkouts?: readonly string[];
  /** The runner host's own clone of a job's repo: used when no checkout matches. */
  resolveRepoPath: (job: Job) => Promise<string> | string;
  /** Where the runner keeps its own clones; never a checkout match. */
  ownReposDir?: string;
  /** Job worktrees go here, as `<worktreesDir>/sf-<jobId>`. */
  worktreesDir: string;
  /** Where the job's worktree starts (default `job.repo.baseRef`): a ref or a SHA in the checkout. */
  startPoint?: (job: Job, checkout: string) => Promise<string> | string;
  /** Per-run private directories (git config, empty tool dirs, the status file) go under here. */
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
  /** The `claude` executable the launch script runs (default `claude` on the session's PATH). */
  claudeBin?: string;
  /** The absolute Node that runs the status hook (default: this process's). */
  node?: string;
  /**
   * The Node that runs a planning session's MCP server and hooks (default: `node`, else this
   * process's).
   */
  nodeBin?: string;
  /** How long Claude may take to come up in its session before the job fails. */
  startTimeoutMs?: number;
  /** How long the prompt may take to be submitted (the hook's `UserPromptSubmit`). */
  submitTimeoutMs?: number;
  /** Reads a live process's command line (default `ps`). Tests script it. */
  readCommand?: ReadCommand;
  pollMs?: number;
  /** A session waiting on a person this long fails (it can be taken over before then). */
  waitingInputTimeoutMs?: number;
  /** The visible screen is logged at most this often (scrolled-off lines are logged as they go). */
  screenLogMs?: number;
  /** Capabilities to declare. Defaults to everything this adapter gives. */
  capabilities?: Capability[];
  exec?: Exec;
  /** The tmux executable and socket (tests use their own socket). */
  tmux?: Omit<TmuxOptions, "exec">;
}

export const DEFAULT_CAPABILITIES: Capability[] = [
  "hooks",
  "ui-takeover",
  "own-hardware",
  "work-item-attachments",
  "steer",
];

/** A factory run branch (`factory/<n>-<slug>-run-<k>`, ADR 0035): the only kind the adapter deletes. */
export function isRunBranch(branch: string): boolean {
  return /^factory\/[0-9]+-[a-z0-9-]+-run-[0-9]+$/.test(branch);
}

/** The file in a job worktree's private git dir that names the job (a planning worktree's name doesn't). */
export const WORKTREE_JOB_FILE = "sf-job";

/**
 * A job's worktree directory name. A planning job's is its session's (ADR 0350): every job of the
 * session gets the same path, so `claude --resume` finds the conversation, which Claude keeps by
 * working directory. Its tmux session is still `sf-<jobId>`.
 */
export function worktreeName(jobId: string, planningSessionId?: string): string {
  if (planningSessionId) {
    return `${SESSION_PREFIX}plan-${planningSessionId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}`;
  }
  return sessionName(jobId);
}

/** A job failed because its live harness isn't configured as the factory set it (ADR 0270). */
export class HarnessConfigMismatch extends Error {
  override name = "HarnessConfigMismatch";
  constructor(readonly problems: string[]) {
    super(`${HARNESS_CONFIG_MISMATCH}: ${problems.join("; ")}`);
  }
}

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

/** How many characters of a steer go in one `send-keys -l`. */
const STEER_CHUNK = 200;

/** Claude's first-run folder trust dialog (a plain terminal doesn't pre-trust the worktree). */
const TRUST_DIALOG = /trust this folder/i;

/** A notification that means the agent is waiting on a person. */
export function isWaitingNotification(line: Pick<StatusLine, "type" | "message">): boolean {
  if (line.type) return /permission|idle|elicitation|input/i.test(line.type);
  return /permission|waiting for your input|needs your/i.test(line.message ?? "");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The last transcript path the status hook reported. */
async function transcriptFromStatus(statusFile: string): Promise<string | null> {
  const lines = parseStatusLines(await readFile(statusFile, "utf8").catch(() => ""));
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.transcript;
    if (t) return t;
  }
  return null;
}

export function createLocalRunner(
  config: LocalRunnerConfig,
): RunnerAdapter<LocalWorkspace, LocalSession> {
  const exec = config.exec ?? nodeExec;
  const tmux = tmuxCli({ ...config.tmux, exec });
  const pollMs = config.pollMs ?? 1000;
  const waitingInputTimeoutMs = config.waitingInputTimeoutMs ?? 15 * 60_000;
  const startTimeoutMs = config.startTimeoutMs ?? 90_000;
  const submitTimeoutMs = config.submitTimeoutMs ?? 30_000;
  const screenLogMs = config.screenLogMs ?? 10_000;
  const capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
  const search = {
    dirs: config.checkouts ?? [],
    exclude: [config.worktreesDir, ...(config.ownReposDir ? [config.ownReposDir] : [])],
    exec,
  };

  /** Keeps the harness's own files out of git in every worktree of the checkout. */
  async function excludePrivateFiles(worktree: string) {
    const path = (
      await run(
        exec,
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
        { cwd: worktree },
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

  /** Removes a job worktree from its checkout; only ever a directory under the worktrees dir. */
  async function removeWorktree(checkout: string, path: string) {
    const base = await realpath(config.worktreesDir).catch(() => config.worktreesDir);
    if (!isUnder(path, base) && !isUnder(path, config.worktreesDir)) {
      throw new Error(`refusing to remove ${path}: not under ${config.worktreesDir}`);
    }
    if (await exists(path)) {
      await exec("git", ["worktree", "remove", "--force", "--force", path], { cwd: checkout });
      await rm(path, { recursive: true, force: true });
    }
    await exec("git", ["worktree", "prune"], { cwd: checkout });
  }

  async function release(
    job: Job,
    workspace: LocalWorkspace | undefined,
    session: LocalSession | undefined,
  ): Promise<void> {
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
      }
    };
    const name = workspace?.name ?? session?.name ?? sessionName(job.jobId);
    // Already gone is fine everywhere: release must be safe to call twice.
    await attempt("kill session", () => tmux.kill(name));
    if (workspace) {
      await attempt("remove worktree", () => removeWorktree(workspace.checkout, workspace.path));
      // The local branch always goes: the pushed run branch (or the diff artifact) is the record.
      // Only ever a factory run branch: the checkout may be the owner's own.
      await attempt("delete branch", async () => {
        if (!isRunBranch(workspace.branch)) return;
        const has = await exec(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`],
          { cwd: workspace.checkout },
        );
        if (has.code === 0) {
          await run(exec, "git", ["branch", "-D", workspace.branch], { cwd: workspace.checkout });
        }
      });
      await attempt("remove run dir", () => removeRunDir(workspace.runDir, workspace.runTmp));
      await attempt("remove attachments", () => removeRunDir(workspace.attachmentsDir));
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  async function checkoutFor(job: Job): Promise<string> {
    const found = await findCheckout(job, search);
    if (found) return found.path;
    const clone = await config.resolveRepoPath(job);
    return realpath(clone).catch(() => clone);
  }

  return {
    async manifest(): Promise<CapabilityManifest> {
      return {
        contractVersion: CONTRACT_VERSION,
        runnerKind: "local",
        harnesses: ["claude-code"],
        capabilities,
      };
    },

    async capacity(): Promise<Capacity> {
      const inUse = (await tmux.jobSessions().catch(() => [])).length;
      return { max: config.maxConcurrent ?? 2, inUse, accepting: true };
    },

    async resolveCheckout(job): Promise<string | null> {
      return (await findCheckout(job, search))?.path ?? null;
    },

    async prepareWorkspace(job, _signal, options): Promise<LocalWorkspace> {
      const planning = job.stage === "planning";
      if (planning && !options?.planningRelay) {
        throw new Error(`planning job ${job.jobId} came without its relay`);
      }
      // ADR 0260 (amended): the owner's checkout of the job's remote, else the host's clone.
      const checkout = await checkoutFor(job);
      const name = sessionName(job.jobId);
      await mkdir(config.worktreesDir, { recursive: true });
      const worktreesDir = await realpath(config.worktreesDir);
      const path = join(worktreesDir, worktreeName(job.jobId, job.planning?.sessionId));
      const runDir = join(config.runsDir, job.jobId);
      const attachmentsDir = join(
        config.attachmentsDir ?? join(dirname(config.runsDir), "attachments"),
        job.jobId,
      );
      // A worktree left by a crashed run of this same job goes first.
      if (await exists(path)) await removeWorktree(checkout, path);
      // So does a local copy of the run branch: it is this run's alone (ADR 0035). Only a factory
      // run branch that no worktree has checked out, never one of the owner's branches.
      const listed = await exec("git", ["worktree", "list", "--porcelain"], { cwd: checkout });
      if (isRunBranch(job.branch) && !listed.stdout.includes(`branch refs/heads/${job.branch}\n`)) {
        await exec("git", ["branch", "-D", job.branch], { cwd: checkout });
      }
      const start = config.startPoint ? await config.startPoint(job, checkout) : job.repo.baseRef;
      // Hooks off (the owner's post-checkout hooks are theirs), no upstream written to the
      // checkout's config.
      await run(
        exec,
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "worktree",
          "add",
          "--no-track",
          "-b",
          job.branch,
          path,
          start,
        ],
        { cwd: checkout },
      );
      const partial: LocalWorkspace = {
        jobId: job.jobId,
        path,
        branch: job.branch,
        baseSha: "",
        checkout,
        name,
        runDir,
        runTmp: "",
        launch: {} as LaunchRecord,
        launchScript: "",
        statusFile: join(runDir, STATUS_FILE),
        attachmentsDir,
      };
      try {
        const baseSha = (await run(exec, "git", ["rev-parse", "HEAD"], { cwd: path })).trim();
        await excludePrivateFiles(path);
        // Which job this worktree is, for reaping: a planning worktree's name is its session's.
        const ownGitDir = (
          await run(exec, "git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
            cwd: path,
          })
        ).trim();
        await writeFile(join(ownGitDir, WORKTREE_JOB_FILE), `${job.jobId}\n`);
        // A linked worktree keeps its objects and refs in the checkout's git dir, outside the
        // worktree: the harness's sandbox must let the run's own git write there (and only there).
        const [commonDir = "", gitDir = ""] = (
          await run(
            exec,
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"],
            { cwd: path },
          )
        )
          .trim()
          .split("\n");
        const projected = await projectHarness(job, {
          worktree: path,
          runDir,
          // The checkout may be the owner's own: the harness reads only its worktree, never the
          // main checkout (its .env files, other branches' work).
          protectPaths: [...new Set([...(config.protectPaths ?? []), checkout])],
          ...(commonDir && gitDir ? { git: { commonDir, gitDir } } : {}),
          ...(capabilities.includes("work-item-attachments") ? { attachmentsDir } : {}),
          // The factory's status hook: agent status from Claude Code's hooks (ADR 0380).
          statusHook: config.node ? { node: config.node } : true,
          ...(config.identity ? { identity: config.identity } : {}),
          ...(config.claudeBin ? { claudeBin: config.claudeBin } : {}),
          ...(planning && options?.planningRelay
            ? {
                planning: {
                  relay: options.planningRelay,
                  ...((config.nodeBin ?? config.node)
                    ? { nodeBin: config.nodeBin ?? config.node }
                    : {}),
                },
              }
            : {}),
        });
        return {
          ...partial,
          baseSha,
          runTmp: projected.runTmp,
          launch: projected.launch,
          launchScript: projected.scriptPath,
          statusFile: projected.statusFile ?? partial.statusFile,
        };
      } catch (err) {
        await release(job, partial, undefined).catch(() => {});
        throw err;
      }
    },

    async attachFiles(_job, workspace, files): Promise<string> {
      if (!capabilities.includes("work-item-attachments")) return "";
      const written = await writeAttachments(workspace.attachmentsDir, files);
      return attachmentsPrompt(written, new Map(files.map((f) => [f.meta.id, f.bytes])));
    },

    async startSession(job, workspace, signal): Promise<LocalSession> {
      const name = workspace.name;
      // A session left by a crashed run of this same job would block the name.
      await tmux.kill(name);
      // The harness's own command (ADR 0270), on the factory's own tmux server.
      await tmux.newSession({
        name,
        cwd: workspace.path,
        command: `exec /bin/sh ${shellQuote(workspace.launchScript)}`,
      });
      const session: LocalSession = {
        jobId: job.jobId,
        sessionRef: name,
        name,
        worktreePath: workspace.path,
        runDir: workspace.runDir,
        statusFile: workspace.statusFile,
        launchScript: workspace.launchScript,
        startedAt: Date.now(),
        promptSentAt: Number.POSITIVE_INFINITY,
        takeover: { label: "Attach in a terminal", hint: attachCommand(name, tmux.socket) },
      };
      const fail = async (error: Error): Promise<never> => {
        await tmux.kill(name).catch(() => {});
        throw error;
      };
      const pause = (ms: number) => sleep(ms, undefined, { signal }).catch(() => {});

      // Wait for Claude to come up: answer its first-run folder trust dialog for the job's own
      // worktree (once), then wait for the launch script's pid and the hook's SessionStart.
      const deadline = Date.now() + startTimeoutMs;
      let trusted = false;
      for (;;) {
        if (signal.aborted) await fail(new Error(String(signal.reason ?? "cancelled")));
        const screen = (await tmux.capture(name)) ?? "";
        const pane = await tmux.paneState(name);
        if (!pane || pane.dead) {
          await fail(new Error(`Claude exited before it started:\n${screen.slice(-2_000)}`));
        }
        if (TRUST_DIALOG.test(screen)) {
          if (trusted) await fail(new Error("Claude asked to trust the worktree twice"));
          await tmux.sendKeys(name, "Down"); // "Yes, I trust this folder"
          await pause(300);
          await tmux.sendKeys(name, "Enter");
          trusted = true;
        } else {
          const pid = await readFile(join(workspace.runDir, PID_FILE), "utf8").catch(() => "");
          const { lines } = await readStatusFrom(workspace.statusFile, 0);
          if (pid.trim() && lines.some((l) => l.event === "SessionStart")) break;
        }
        if (Date.now() > deadline) {
          await fail(
            new Error(
              `Claude did not start within ${Math.round(startTimeoutMs / 1000)} s:\n${screen.slice(-2_000)}`,
            ),
          );
        }
        await pause(Math.min(pollMs, 500));
      }

      // Before the job does anything: the live process and its settings must be exactly what the
      // harness set. Otherwise kill it and fail the job (incident 2026-11-11 #6).
      const problems = await verifyLaunch(workspace.launch, config.readCommand);
      if (problems.length > 0) await fail(new HarnessConfigMismatch(problems));

      // The prompt goes in a file; the terminal gets one short line pointing at it. A long paste
      // into the Claude terminal arrives truncated (incident 2026-11-11 #8).
      await writeFile(join(workspace.path, PROMPT_FILE), job.harness.prompt, { mode: 0o600 });
      session.startedAt = Date.now();
      session.promptSentAt = session.startedAt;
      try {
        await tmux.sendText(name, PROMPT_POINTER);
        await pause(200);
        await tmux.sendKeys(name, "Enter");
      } catch (err) {
        await fail(new Error(`sending the prompt: ${err instanceof Error ? err.message : err}`));
      }
      // Submitted once the hook reports the turn. An Enter that arrived with the typed text may be
      // taken as part of it: press Enter again while waiting (an empty Enter does nothing).
      const submitBy = Date.now() + submitTimeoutMs;
      let nextEnter = Date.now() + 5_000;
      for (;;) {
        if (signal.aborted) await fail(new Error(String(signal.reason ?? "cancelled")));
        const { lines } = await readStatusFrom(workspace.statusFile, 0);
        if (lines.some((l) => l.event === "UserPromptSubmit" && l.time >= session.promptSentAt)) {
          break;
        }
        if (Date.now() > submitBy) {
          const screen = (await tmux.capture(name)) ?? "";
          await fail(
            new Error(
              `the prompt was not submitted within ${Math.round(submitTimeoutMs / 1000)} s:\n${screen.slice(-2_000)}`,
            ),
          );
        }
        if (Date.now() > nextEnter) {
          await tmux.sendKeys(name, "Enter").catch(() => {});
          nextEnter = Date.now() + 5_000;
        }
        await pause(Math.min(pollMs, 250));
      }
      return session;
    },

    async *events(job, session, signal): AsyncIterable<AdapterEvent> {
      // A planning session (ADR 0300) idles in its Stop hook between turns: Stop and waiting are
      // normal there. It ends when the host stops it (a yield, the gate decided) or Claude exits.
      const planning = job.stage === "planning";
      let offset = 0;
      let emittedHistory = 0;
      let lastScreen = "";
      let lastScreenAt = 0;
      let status: AgentStatus | undefined;
      let submitted = false;
      let waitingSince: number | null = null;
      let transcript: string | null = null;
      // The transcript is tailed for what the agent says (ADR 0400). A resumed planning
      // conversation's file holds earlier turns: only messages from this session are sent.
      let tailing: string | null = null;
      let transcriptOffset = 0;
      const since = session.startedAt - 5_000;
      /** What the agent said, not yet yielded, oldest first. */
      const said: { at: number | null; event: AdapterEvent }[] = [];
      const readSaid = async () => {
        if (!transcript) return;
        if (tailing !== transcript) {
          tailing = transcript;
          transcriptOffset = 0;
        }
        const read = await readTranscriptFrom(transcript, transcriptOffset).catch(() => null);
        if (!read) return;
        transcriptOffset = read.offset;
        for (const m of read.messages) {
          if (m.at !== null && m.at < since) continue;
          said.push({
            at: m.at,
            event: { type: "message", role: m.role, text: clip(m.text, MESSAGE_MAX - 1) },
          });
        }
      };
      /** The messages said before `time` (all of them without one). */
      const saidUpTo = (time = Number.POSITIVE_INFINITY): AdapterEvent[] => {
        const out: AdapterEvent[] = [];
        while (said[0] && (said[0].at === null || said[0].at < time)) {
          out.push((said.shift() as { event: AdapterEvent }).event);
        }
        return out;
      };
      const resultPath = join(session.worktreePath, RESULT_FILE);
      const setStatus = (next: AgentStatus, message?: string): AdapterEvent[] => {
        if (next !== "waiting_input") waitingSince = null;
        if (next === status) return [];
        status = next;
        return [{ type: "agent.status", status: next, ...(message ? { message } : {}) }];
      };
      const summaryFromTranscript = async (): Promise<string | undefined> => {
        const path =
          transcript ??
          (await findTranscript(session.worktreePath, { since: session.startedAt - 60_000 }).catch(
            () => null,
          ));
        if (!path) return undefined;
        const summary = await readTranscript(path).catch(() => null);
        return summary?.lastAssistantText ?? undefined;
      };
      const exited = async (): Promise<AdapterEvent> => {
        const hasResult = await exists(resultPath);
        const summary = await summaryFromTranscript();
        return {
          type: "session.ended",
          outcome: hasResult ? "completed" : "failed",
          summary:
            summary ??
            (hasResult
              ? "the agent exited after writing its result"
              : "the agent's session exited"),
        };
      };

      /**
       * Terminal output: lines that scrolled off since the last read, and now and then the visible
       * screen (Claude's TUI redraws it in place).
       */
      const logs = async (pane: PaneState | null): Promise<AdapterEvent[]> => {
        if (!pane) return [];
        const out: AdapterEvent[] = [];
        if (pane.historySize > emittedHistory) {
          const text = await tmux.capture(session.name, {
            start: -(pane.historySize - emittedHistory),
            end: -1,
          });
          if (text?.trim()) out.push({ type: "log", stream: "terminal", text: clip(text, 60_000) });
        }
        emittedHistory = pane.historySize;
        if (Date.now() - lastScreenAt >= screenLogMs) {
          const screen = await tmux.capture(session.name);
          if (screen?.trim() && screen !== lastScreen) {
            out.push({ type: "log", stream: "terminal", text: clip(screen, 60_000), screen: true });
            lastScreen = screen;
          }
          lastScreenAt = Date.now();
        }
        return out;
      };
      /** The output since the last poll, before the session's end is reported. */
      const finalLogs = async () => {
        await readSaid();
        return [
          ...saidUpTo(),
          ...(await logs(await tmux.paneState(session.name).catch(() => null))),
        ];
      };

      while (!signal.aborted) {
        const pane = await tmux.paneState(session.name).catch(() => null);
        yield* await logs(pane);

        // Status from the hook file, in order, with what the agent said before each line first.
        const read = await readStatusFrom(session.statusFile, offset);
        offset = read.offset;
        for (const line of read.lines) if (line.transcript) transcript = line.transcript;
        await readSaid();
        for (const line of read.lines) {
          yield* saidUpTo(line.time);
          switch (line.event) {
            case "UserPromptSubmit":
              if (line.time >= session.promptSentAt) submitted = true;
              yield* setStatus("working");
              break;
            case "PreToolUse":
              yield* setStatus("working");
              yield {
                type: "tool",
                name: line.tool ?? "",
                ...(line.input ? { input: clip(line.input, 7_000) } : {}),
              };
              break;
            case "PostToolUse":
              yield* setStatus("working");
              break;
            case "Notification":
              if (isWaitingNotification(line)) {
                yield* setStatus("waiting_input", line.message);
                waitingSince ??= line.time;
              }
              break;
            case "StopFailure":
              yield* setStatus("error", line.message);
              break;
            case "Stop":
              // A Stop from before the prompt was submitted (nothing asked yet) is not the end.
              if (!submitted) break;
              if (planning) {
                yield* setStatus("idle");
                break;
              }
              yield* setStatus("done");
              yield* await finalLogs();
              {
                const summary = await summaryFromTranscript();
                yield {
                  type: "session.ended",
                  outcome: "completed",
                  ...(summary ? { summary } : {}),
                };
              }
              return;
            case "SessionEnd":
              yield* await finalLogs();
              yield await exited();
              return;
          }
        }
        // Said after the last hook line: nothing later has been reported yet.
        yield* saidUpTo();

        if (!pane || pane.dead) {
          yield* await finalLogs();
          yield await exited();
          return;
        }
        if (
          !planning &&
          waitingSince !== null &&
          Date.now() - waitingSince > waitingInputTimeoutMs
        ) {
          yield {
            type: "session.ended",
            outcome: "failed",
            summary: `the agent waited for input for over ${Math.round(waitingInputTimeoutMs / 60_000)} min`,
          };
          return;
        }
        await sleep(pollMs, undefined, { signal }).catch(() => {});
      }
      const reason = String(signal.reason ?? "");
      yield {
        type: "session.ended",
        outcome: reason.includes("timeout") ? "timed_out" : "cancelled",
      };
    },

    async collectArtifacts(_job, workspace, session): Promise<Artifact[]> {
      const artifacts: Artifact[] = [];
      if (session) {
        const screen = await tmux.capture(session.name).catch(() => null);
        if (screen) artifacts.push({ kind: "log", name: "terminal-screen", text: screen });
        const transcript =
          (await transcriptFromStatus(session.statusFile)) ??
          (await findTranscript(workspace.path, { since: session.startedAt - 60_000 }).catch(
            () => null,
          ));
        if (transcript) {
          const summary = await readTranscript(transcript).catch(() => null);
          const checks = summary ? checkOutputLog(summary) : null;
          if (checks) artifacts.push({ kind: "log", name: "check-output", text: checks });
          if (summary?.lastAssistantText) {
            artifacts.push({
              kind: "log",
              name: "agent-final-message",
              text: summary.lastAssistantText,
            });
          }
          // What the run used, per model (spec 09 M3): counts only, never keys or bills.
          if (summary && summary.usage.length > 0) {
            artifacts.push({
              kind: "usage",
              harness: "claude-code",
              entries: summary.usage,
              ...(summary.wallMs !== null ? { wallMs: summary.wallMs } : {}),
            });
          }
        }
      }
      // No `browser` capability: screenshot evidence is reported skipped by the host, as for any
      // runner without it.
      return artifacts;
    },

    release,

    /**
     * A person's message (ADR 0400): one sanitised line, typed in short pieces so the TUI doesn't
     * take it as a paste (a long paste arrives truncated, incident 2026-11-11 #8), then Enter. Claude
     * Code queues a message typed while it works and reads it at its next step.
     */
    async steer(session, text) {
      const line = steerText(text);
      if (!line) return;
      for (let i = 0; i < line.length; i += STEER_CHUNK) {
        await tmux.sendText(session.name, line.slice(i, i + STEER_CHUNK));
        if (i + STEER_CHUNK < line.length) await sleep(30);
      }
      await sleep(200);
      await tmux.sendKeys(session.name, "Enter");
    },
  };
}
