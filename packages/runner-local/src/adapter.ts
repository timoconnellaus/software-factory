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
  accountConfigDir,
  attachmentsPrompt,
  carryConversation,
  checkOutputLog,
  DEFAULT_HARNESS_ACCOUNT,
  findTranscript,
  HARNESS_CONFIG_MISMATCH,
  type HarnessAccount,
  isUsageLimitText,
  type LaunchRecord,
  PID_FILE,
  PRIVATE_WORKTREE_FILES,
  PROMPT_FILE,
  PROMPT_POINTER,
  parseStatusLines,
  projectHarness,
  type ReadCommand,
  RUN_SETTINGS_FILE,
  readLaunchRecord,
  readStatusFrom,
  readTranscript,
  readTranscriptFrom,
  removeRunDir,
  STATUS_FILE,
  type StatusLine,
  shellQuote,
  usageLimitOf,
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
import { branchExists, checkedOutBranches, deleteRunBranch, markRunBranch } from "./branches.ts";
import { exists, findCheckout, isUnder } from "./checkouts.ts";
import { type Exec, nodeExec, run } from "./exec.ts";
import {
  HarnessStillRunning,
  harnessMayBeAlive,
  hostProcs,
  type Procs,
  type StopOptions,
  stopHarness,
} from "./procs.ts";
import {
  killStream,
  type LocalSessionMode,
  type StreamOptions,
  type StreamState,
  startStreamSession,
  steerStream,
  streamAlive,
  streamEvents,
  takeOverStream,
} from "./stream.ts";
import { openTmuxTerminal } from "./terminal.ts";
import {
  attachCommand,
  type PaneState,
  SESSION_PREFIX,
  sessionName,
  type TmuxOptions,
  TmuxUnavailable,
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
  /** The Claude account the run uses (ADR 0410), taken when the workspace was prepared. */
  account: HarnessAccount;
  /**
   * How the live harness's command line is read, when `ps` on the host can't see it (a container
   * job reads it with `docker exec`, ADR 0430). Default: the adapter's `readCommand`.
   */
  readCommand?: ReadCommand;
  /** More checks before the prompt (a container job's own configuration, ADR 0430). */
  launchChecks?: () => Promise<string[]>;
  /**
   * This workspace created `branch` in the checkout (ADR 0531): release deletes exactly that
   * branch, whatever its name, when no worktree has it checked out.
   */
  createdBranch?: boolean;
  /**
   * Writes a file the session reads (the prompt) where the session runs, when that isn't this
   * machine (a sprite, ADR 0480). The host's copy is written as well.
   */
  writeRunFile?: (path: string, content: string) => Promise<void>;
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
  /** A stream-json session's process (ADR 0450); absent in tmux. */
  stream?: StreamState;
  /** The run's Claude account (ADR 0410) and its config dir, where its transcript goes. */
  account: string;
  configDir: string;
  /**
   * The run's settings path (`<runDir>/claude-settings.json`), on its Claude's command line for as
   * long as it runs: how the runner finds, stops and checks its processes on the host (ADR 0530).
   * Absent when they aren't the host's to see (a container job, ADR 0430).
   */
  settingsPath?: string;
  /**
   * When the last steer was typed (its Enter), in tmux mode: a Stop before the turn that answers
   * it doesn't end the job (spec 43).
   */
  steeredAt?: number;
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
  /**
   * How sessions run (ADR 0450): `tmux` (the TUI in tmux, the default) or `stream-json` (Claude
   * headless as a two-way stream, shown as a chat; declares `chat`).
   */
  session?: LocalSessionMode;
  /**
   * How long to wait for a steer's turn after a result (stream) or a Stop (tmux) before the job
   * ends anyway (Claude may fold it into the turn that ended). Default 15 s.
   */
  turnGraceMs?: number;
  /** Stream mode: the session's environment (default: the host's, credentials dropped). */
  streamEnv?: Record<string, string>;
  exec?: Exec;
  /** The tmux executable and socket (tests use their own socket). */
  tmux?: Omit<TmuxOptions, "exec">;
  /** How the host's processes are read and signalled (default `ps` and `kill`; ADR 0530). */
  procs?: Procs;
  /** How long a job's processes get after TERM, and after KILL, when it is stopped. */
  stop?: StopOptions;
  /**
   * After the tmux session is gone, how long the job waits for its Claude to exit before it ends
   * anyway (release then stops it). Default 30 s.
   */
  goneGraceMs?: number;
  /**
   * The Claude account a job uses (ADR 0410): the host's active one, asked once when the job's
   * workspace is prepared, so a switch never touches a running job. Default: the host's own.
   */
  account?: (job: Job) => Promise<HarnessAccount> | HarnessAccount;
  /**
   * The config dirs of every account on the host, where a planning session resumed on another
   * account than it started on finds its conversation.
   */
  accountConfigDirs?: () => Promise<string[]> | string[];
  /**
   * A run ended: with the usage-limit message Claude gave, or null when it ended without one
   * (ADR 0410: the host surfaces it per account; nothing switches on its own).
   */
  onAccountUsage?: (account: string, usageLimit: string | null) => void;
}

export const DEFAULT_CAPABILITIES: Capability[] = [
  "hooks",
  "ui-takeover",
  "own-hardware",
  "work-item-attachments",
  "steer",
  "terminal",
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
  const streamMode = config.session === "stream-json";
  // `chat` follows the session mode, whatever else is configured.
  const capabilities = [
    // A stream session has no terminal to share (ADR 0440): its takeover is by resume.
    ...(config.capabilities ?? DEFAULT_CAPABILITIES).filter(
      (c) => c !== "chat" && !(streamMode && c === "terminal"),
    ),
    ...(streamMode ? (["chat"] as Capability[]) : []),
  ];
  /** Live stream sessions, for capacity (tmux counts its own sessions). */
  const streams = new Map<string, LocalSession>();
  /** Jobs with a tmux session this adapter started: capacity's count when tmux can't answer. */
  const started = new Set<string>();
  const procs = config.procs ?? hostProcs(exec);
  const goneGraceMs = config.goneGraceMs ?? 30_000;
  const turnGraceMs = config.turnGraceMs ?? 15_000;
  const streamOptions = (): StreamOptions => ({
    ...(config.readCommand ? { readCommand: config.readCommand } : {}),
    startTimeoutMs,
    pollMs,
    waitingInputTimeoutMs,
    ...(config.turnGraceMs !== undefined ? { turnGraceMs: config.turnGraceMs } : {}),
    ...(config.streamEnv ? { env: config.streamEnv } : {}),
  });
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

  /** The run's settings path, when its processes are the host's to see (not a container's). */
  const settingsPathOf = (workspace?: LocalWorkspace, session?: LocalSession) =>
    session?.settingsPath ??
    (workspace && !workspace.readCommand ? join(workspace.runDir, RUN_SETTINGS_FILE) : undefined);

  /**
   * Jobs whose processes survived their release (ADR 0530): tried again on every capacity read and
   * counted as in use until they're gone.
   */
  const survivors = new Map<string, string>();
  const retrySurvivors = async () => {
    for (const [jobId, settingsPath] of survivors) {
      await stopHarness(procs, settingsPath, { termGraceMs: 0, killGraceMs: 1_000 }).then(
        () => survivors.delete(jobId),
        () => {},
      );
    }
  };

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
    const live = session ?? streams.get(job.jobId);
    if (live?.stream) killStream(live.stream);
    streams.delete(job.jobId);
    started.delete(job.jobId);
    // A tmux that doesn't answer is no reason to leave Claude running (incident #11 (2026-11-12)):
    // the job's processes are stopped from the process table either way, and a session left on
    // the server is reaped later.
    const killed = await tmux.kill(name).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    const settingsPath = settingsPathOf(workspace, live);
    let survived: HarnessStillRunning | null = null;
    if (settingsPath) {
      try {
        await stopHarness(procs, settingsPath, config.stop);
        survivors.delete(job.jobId);
      } catch (err) {
        survived =
          err instanceof HarnessStillRunning
            ? err
            : new HarnessStillRunning(settingsPath, [], String(err));
        survivors.set(job.jobId, settingsPath);
      }
    } else if (killed) {
      errors.push(`kill session: ${killed}`);
    }
    if (workspace) {
      await attempt("remove worktree", () => removeWorktree(workspace.checkout, workspace.path));
      // The local branch always goes: the pushed run branch (or the diff artifact) is the record.
      // Only the branch this workspace created (ADR 0531), or a factory run branch from before the
      // marker, and only when no worktree has it checked out: the checkout may be the owner's own.
      await attempt("delete branch", async () => {
        if (!workspace.createdBranch && !isRunBranch(workspace.branch)) return;
        await deleteRunBranch(workspace.checkout, workspace.branch, exec);
      });
      await attempt("remove run dir", () => removeRunDir(workspace.runDir, workspace.runTmp));
      await attempt("remove attachments", () => removeRunDir(workspace.attachmentsDir));
    }
    if (survived) {
      const e = survived as HarnessStillRunning;
      if (errors.length) e.message += `; ${errors.join("; ")}`;
      throw e;
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
      await retrySurvivors();
      const max = config.maxConcurrent ?? 2;
      const alive = [...streams.values()].filter(streamAlive).length + survivors.size;
      try {
        return { max, inUse: (await tmux.jobSessions()).length + alive, accepting: true };
      } catch (err) {
        // tmux can't say how many sessions it holds: never read that as none (incident
        // 2026-11-12 #1). Count the ones this adapter started, and take nothing new for now.
        return {
          max,
          inUse: started.size + alive,
          accepting: false,
          paused: {
            reason: "tmux",
            pools: ["heavy", "light"],
            detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          },
        };
      }
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
      // A crashed run of this same job may have left its Claude running (ADR 0530): stop it first.
      await stopHarness(procs, join(runDir, RUN_SETTINGS_FILE), config.stop);
      // A worktree left by a crashed run of this same job goes first.
      if (await exists(path)) await removeWorktree(checkout, path);
      // So does a local copy of the run branch: `job.branch` is this run's alone (ADR 0035, one
      // branch per run), whatever its name (an attached PR's runs are `<pr-branch>-run-<k>`), so a
      // copy no worktree has checked out is stale (ADR 0531). Checked out anywhere: refuse.
      const holder = (await checkedOutBranches(checkout, exec)).get(job.branch);
      if (holder) {
        throw new Error(
          `the run branch ${job.branch} is checked out at ${holder}; not taking it over`,
        );
      }
      if (await branchExists(checkout, job.branch, exec)) {
        await deleteRunBranch(checkout, job.branch, exec);
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
        account: DEFAULT_HARNESS_ACCOUNT,
        createdBranch: true,
      };
      try {
        // The marker that says the factory made this branch, for the sweep after a crash.
        await markRunBranch(checkout, job.branch, exec);
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
        // The host's active account, now: the job keeps it to the end (ADR 0410).
        const account = (await config.account?.(job)) ?? DEFAULT_HARNESS_ACCOUNT;
        partial.account = account;
        // A planning session resumed after the owner switched accounts: its conversation is in
        // the old account's config dir, and `claude --resume` looks in the new one.
        if (planning && job.planning?.resume && config.accountConfigDirs) {
          await carryConversation({
            cwd: path,
            sessionId: job.planning.sessionRef,
            to: accountConfigDir(account),
            from: await config.accountConfigDirs(),
          });
        }
        const projected = await projectHarness(job, {
          account,
          worktree: path,
          runDir,
          // The checkout may be the owner's own: the harness reads only its worktree, never the
          // main checkout (its .env files, other branches' work).
          protectPaths: [...new Set([...(config.protectPaths ?? []), checkout])],
          ...(commonDir && gitDir ? { git: { commonDir, gitDir } } : {}),
          ...(capabilities.includes("work-item-attachments") ? { attachmentsDir } : {}),
          ...(streamMode ? { session: "stream" as const } : {}),
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
      if (streamMode) {
        // ADR 0450: a two-way stream-json session instead of the TUI, same launch and check.
        const session = await startStreamSession(
          job,
          workspace,
          signal,
          streamOptions(),
          (problems) => new HarnessConfigMismatch(problems),
        );
        const settingsPath = settingsPathOf(workspace);
        if (settingsPath) session.settingsPath = settingsPath;
        streams.set(job.jobId, session);
        return session;
      }
      const name = workspace.name;
      const settingsPath = settingsPathOf(workspace);
      /** Kills the session and stops whatever it started, whether or not tmux answers. */
      const stopAll = async () => {
        const killed = await tmux.kill(name).then(
          () => "",
          (err: unknown) => `; tmux kill-session: ${err instanceof Error ? err.message : err}`,
        );
        if (settingsPath) await stopHarness(procs, settingsPath, config.stop);
        else if (killed) throw new Error(killed.slice(2));
        started.delete(job.jobId);
      };
      // A session left by a crashed run of this same job would block the name.
      await stopAll();
      // The harness's own command (ADR 0270), on the factory's own tmux server. A new-session
      // that timed out may still have started: stop it before failing.
      started.add(job.jobId);
      try {
        await tmux.newSession({
          name,
          cwd: workspace.path,
          command: `exec /bin/sh ${shellQuote(workspace.launchScript)}`,
        });
      } catch (err) {
        await stopAll().catch(() => {});
        throw err;
      }
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
        account: workspace.account.name,
        configDir: accountConfigDir(workspace.account),
        ...(settingsPath ? { settingsPath } : {}),
      };
      const fail = async (error: Error): Promise<never> => {
        await stopAll().catch((err) => {
          error.message += `; ${err instanceof Error ? err.message : err}`;
        });
        throw error;
      };
      const pause = (ms: number) => sleep(ms, undefined, { signal }).catch(() => {});

      // Wait for Claude to come up: answer its first-run folder trust dialog for the job's own
      // worktree (once), then wait for the launch script's pid and the hook's SessionStart. A tmux
      // that doesn't answer for a while is no news (incident #11 (2026-11-12)): the deadline decides.
      const deadline = Date.now() + startTimeoutMs;
      let trusted = false;
      for (;;) {
        if (signal.aborted) await fail(new Error(String(signal.reason ?? "cancelled")));
        let screen = "";
        let pane: PaneState | null;
        try {
          screen = (await tmux.capture(name)) ?? "";
          pane = await tmux.paneState(name);
        } catch (err) {
          if (!(err instanceof TmuxUnavailable)) throw err;
          if (Date.now() > deadline) {
            await fail(new Error(`Claude did not start: ${err.message}`));
          }
          await pause(Math.min(pollMs, 500));
          continue;
        }
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
      const problems = [
        ...(await verifyLaunch(workspace.launch, workspace.readCommand ?? config.readCommand)),
        ...((await workspace.launchChecks?.()) ?? []),
      ];
      if (problems.length > 0) await fail(new HarnessConfigMismatch(problems));

      // The prompt goes in a file; the terminal gets one short line pointing at it. A long paste
      // into the Claude terminal arrives truncated (incident 2026-11-11 #8).
      await writeFile(join(workspace.path, PROMPT_FILE), job.harness.prompt, { mode: 0o600 });
      if (workspace.writeRunFile) {
        await workspace
          .writeRunFile(join(workspace.path, PROMPT_FILE), job.harness.prompt)
          .catch((err) =>
            fail(new Error(`writing the prompt: ${err instanceof Error ? err.message : err}`)),
          );
      }
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
          const screen = (await tmux.capture(name).catch(() => null)) ?? "";
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
      if (session.stream) {
        yield* streamEvents(job, session, signal, streamOptions());
        return;
      }
      // A planning session (ADR 0300) idles in its Stop hook between turns: Stop and waiting are
      // normal there. It ends when the host stops it (a yield, the gate decided) or Claude exits.
      const planning = job.stage === "planning";
      let offset = 0;
      let emittedHistory = 0;
      let lastScreen = "";
      let lastScreenAt = 0;
      let status: AgentStatus | undefined;
      let submitted = false;
      /** The latest submitted turn's time (the prompt's, or a steer's). */
      let lastSubmitAt = 0;
      /** Since when a Stop came while a steer's turn was still owed. */
      let steerOwedSince: number | null = null;
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
          (await findTranscript(session.worktreePath, {
            since: session.startedAt - 60_000,
            configDirs: [session.configDir],
          }).catch(() => null));
        if (!path) return undefined;
        const summary = await readTranscript(path).catch(() => null);
        return summary?.lastAssistantText ?? undefined;
      };
      // Usage limits are surfaced against the run's account, never acted on (ADR 0410).
      let usageLimit: string | null = null;
      const reportUsage = (outcome: string) => {
        if (outcome === "completed" || usageLimit) {
          config.onAccountUsage?.(session.account, usageLimit);
        }
      };
      const limitEvent = (message: string): AdapterEvent => ({
        type: "agent.status",
        status: "error",
        message: clip(`usage limit on Claude account "${session.account}": ${message}`, 1_000),
      });
      const exited = async (): Promise<AdapterEvent> => {
        const hasResult = await exists(resultPath);
        const summary = await summaryFromTranscript();
        if (!usageLimit && !hasResult && isUsageLimitText(summary)) usageLimit = summary ?? null;
        reportUsage(hasResult ? "completed" : "failed");
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
          const text = await tmux
            .capture(session.name, { start: -(pane.historySize - emittedHistory), end: -1 })
            // Not read this time (tmux didn't answer): the same lines are asked for next poll.
            .catch(() => undefined);
          if (text === undefined) return out;
          if (text?.trim()) out.push({ type: "log", stream: "terminal", text: clip(text, 60_000) });
        }
        emittedHistory = pane.historySize;
        if (Date.now() - lastScreenAt >= screenLogMs) {
          const screen = await tmux.capture(session.name).catch(() => null);
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

      /** The job's end at a Stop: done, unless the turn only said the usage limit was hit. */
      async function* endAtStop(): AsyncGenerator<AdapterEvent> {
        yield* setStatus("done");
        yield* await finalLogs();
        const summary = await summaryFromTranscript();
        // Claude's last word was the usage-limit notice: the turn didn't do the work.
        if (isUsageLimitText(summary) && !(await exists(resultPath))) {
          usageLimit = summary ?? "usage limit reached";
          yield limitEvent(usageLimit);
          reportUsage("failed");
          yield {
            type: "session.ended",
            outcome: "failed",
            summary: `usage limit on Claude account "${session.account}": ${usageLimit}`,
          };
          return;
        }
        reportUsage("completed");
        yield { type: "session.ended", outcome: "completed", ...(summary ? { summary } : {}) };
      }

      // tmux not answering is not the session ending (incident #11 (2026-11-12)): the job keeps
      // running, says so once, and goes on reading the hook file, which doesn't need tmux.
      let degraded: string | null = null;
      /** Since when the session has been gone while its Claude may still run. */
      let goneSince: number | null = null;
      while (!signal.aborted) {
        let pane: PaneState | null | undefined;
        try {
          pane = await tmux.paneState(session.name);
          if (degraded) {
            degraded = null;
            yield { type: "log", stream: "stderr", text: "runner: tmux answers again" };
          }
        } catch (err) {
          if (!(err instanceof TmuxUnavailable)) throw err;
          pane = undefined;
          if (!degraded) {
            degraded = err.message;
            yield {
              type: "log",
              stream: "stderr",
              text: clip(
                `runner: tmux isn't answering (${err.message}); the session is treated as still running`,
                2_000,
              ),
            };
          }
        }
        yield* await logs(pane ?? null);

        // Status from the hook file, in order, with what the agent said before each line first.
        const read = await readStatusFrom(session.statusFile, offset);
        offset = read.offset;
        for (const line of read.lines) if (line.transcript) transcript = line.transcript;
        await readSaid();
        for (const line of read.lines) {
          yield* saidUpTo(line.time);
          switch (line.event) {
            case "UserPromptSubmit":
              if (line.time >= session.promptSentAt) {
                submitted = true;
                lastSubmitAt = Math.max(lastSubmitAt, line.time);
                steerOwedSince = null;
              }
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
            case "StopFailure": {
              const limit = usageLimitOf(line);
              if (!limit) {
                yield* setStatus("error", line.message);
                break;
              }
              usageLimit = limit;
              status = "error";
              yield limitEvent(limit);
              // A planning session waits for the owner (it may switch and steer); a job has
              // nothing left to do on this account: it fails now instead of idling to a timeout.
              if (planning) break;
              yield* await finalLogs();
              reportUsage("failed");
              yield {
                type: "session.ended",
                outcome: "failed",
                summary: `usage limit on Claude account "${session.account}": ${limit}`,
              };
              return;
            }
            case "Stop":
              // A Stop from before the prompt was submitted (nothing asked yet) is not the end.
              if (!submitted) break;
              if (planning) {
                yield* setStatus("idle");
                break;
              }
              // A steer typed after the last submitted turn is queued by Claude and runs after
              // this Stop (spec 43): the job ends at the Stop of the turn that answers it, or
              // after a grace period if Claude folded it into this one.
              if ((session.steeredAt ?? 0) > lastSubmitAt) {
                yield* setStatus("idle");
                steerOwedSince ??= Date.now();
                break;
              }
              yield* endAtStop();
              return;
            case "SessionEnd":
              yield* await finalLogs();
              yield await exited();
              return;
          }
        }
        // Said after the last hook line: nothing later has been reported yet.
        yield* saidUpTo();

        // The steered turn never came: Claude took the steer into the turn that stopped.
        if (steerOwedSince !== null && Date.now() - steerOwedSince > turnGraceMs) {
          yield* endAtStop();
          return;
        }

        // Ended only once its Claude is confirmed gone from the process table (unknown is alive).
        const mayBeAlive = () =>
          session.settingsPath
            ? harnessMayBeAlive(procs, session.settingsPath)
            : Promise.resolve(pane === undefined);
        if (pane === undefined) {
          // tmux can't say; the process table can.
          if (session.settingsPath && !(await mayBeAlive())) {
            yield* await finalLogs();
            yield await exited();
            return;
          }
        } else if (!pane || pane.dead) {
          if (await mayBeAlive()) {
            goneSince ??= Date.now();
            if (Date.now() - goneSince < goneGraceMs) {
              await sleep(pollMs, undefined, { signal }).catch(() => {});
              continue;
            }
            yield* await finalLogs();
            yield {
              type: "session.ended",
              outcome: "failed",
              summary: `the tmux session ${pane ? "exited" : "went away"} but the agent's process was still running ${Math.round(goneGraceMs / 1000)} s later; the runner stops it`,
            };
            return;
          }
          yield* await finalLogs();
          yield await exited();
          return;
        } else {
          goneSince = null;
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
          (await findTranscript(workspace.path, {
            since: session.startedAt - 60_000,
            configDirs: [session.configDir],
          }).catch(() => null));
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
      if (session.stream) return steerStream(session, text);
      const line = steerText(text);
      if (!line) return;
      for (let i = 0; i < line.length; i += STEER_CHUNK) {
        await tmux.sendText(session.name, line.slice(i, i + STEER_CHUNK));
        if (i + STEER_CHUNK < line.length) await sleep(30);
      }
      await sleep(200);
      session.steeredAt = Date.now();
      await tmux.sendKeys(session.name, "Enter");
    },

    /**
     * Hands a stream session to a person (ADR 0450): stops it cleanly; `events()` then reports the
     * `claude --resume` command and follows the resumed session. A tmux session is taken over by
     * attaching, so there is nothing to stop.
     */
    async takeover(session) {
      if (!session.stream) throw new Error("attach to the tmux session to take it over");
      await takeOverStream(session);
    },

    /**
     * The web terminal (ADR 0440): a tmux control-mode client on the job's session, started while
     * someone watches from the dashboard and closed when they leave. A stream session (ADR 0450)
     * has no terminal: it is taken over by resume instead.
     */
    openTerminal(session, options) {
      if (session.stream) {
        return Promise.reject(new Error("a stream-json session has no terminal: take it over"));
      }
      return openTmuxTerminal({
        ...options,
        session: session.name,
        socket: tmux.socket,
        ...(config.tmux?.bin ? { bin: config.tmux.bin } : {}),
      });
    },
  };
}
