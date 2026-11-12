// The runner contract (ADR 0014, ADR 0100). The factory schedules and runners execute: the core knows
// only these shapes, never a particular runner. An adapter (runner-local, later dev
// boxes, CF Sandbox, GitHub Actions) implements `RunnerAdapter`; the generic runner host
// (`local/runner-host`) claims jobs over the signed channel and drives the adapter:
//
//   claim job → fetch job token → prepare workspace (run branch) → start harness session
//             → stream events → collect artifacts → push run branch → hand back → release
//
// Runner-specific features (UI takeover, an embedded browser, auto-registering sessions) are
// optional capabilities an adapter declares in its manifest. The scheduler only routes a job to a
// runner whose manifest covers the job's `requires`.
//
// Runtime-neutral: no Node APIs, so the cloud (Workers) and the host (Node) share it. Wire shapes are
// zod schemas in ./wire.ts; the types here that cross the wire are inferred from them.
import type { z } from "zod";
import type { TerminalSize } from "./terminal.ts";
import type {
  AttachmentMeta,
  artifactSchema,
  capabilityManifestSchema,
  capacitySchema,
  handbackSchema,
  jobSchema,
  runnerEventSchema,
  storedArtifactSchema,
} from "./wire.ts";

/**
 * The manifest's contract version. The engine refuses a heartbeat whose manifest names another
 * one, so a runner on the old value could never learn it should update: don't bump it while
 * runners update themselves. A breaking change bumps RUNNER_COMPAT instead (ADR 0520).
 */
export const CONTRACT_VERSION = "1" as const;

/**
 * The runner compatibility level (ADR 0520). The engine sends its own value on every heartbeat as
 * `minRunnerCompat`; a runner whose code has a lower one stops claiming at once and updates when
 * its running jobs end. Every other deploy leaves a runner claiming on its current code until it is
 * idle, so the engine must keep serving a runner one or more commits behind it.
 *
 * The rule, while this number stays the same:
 * - **Runner → engine requests** (heartbeat, claim, events, handback, …) are validated by the
 *   engine with zod. A field may be added only as optional, an enum may only grow, and nothing a
 *   runner at this level sends may be refused or change meaning.
 * - **Engine → runner answers** are read by the runner without validation (`JSON.parse`), and it
 *   ignores fields and command kinds it doesn't know. A new answer field or command kind is fine
 *   when an older runner can safely ignore it.
 * - **A job an older runner can't run correctly** (a new stage, a new way to run a stage, a field
 *   it must act on) is gated on a capability the new runner declares (`requires`, `canRun`), so
 *   the scheduler never hands it to an older runner.
 * - Anything else that breaks a runner at this level (removing or renaming a field or call,
 *   changing what one means, a stricter request schema) bumps this number in the same PR. Bump it
 *   deliberately: every runner then drains at the next heartbeat after the deploy.
 */
export const RUNNER_COMPAT = 1;

/**
 * Optional things a runner can do beyond the core lifecycle (names from CONTEXT.md, Capability).
 * - `browser`: can open a URL in a browser it controls and take screenshots (visual evidence).
 * - `ui-takeover`: a person can attach to the live session in the runner's own UI and steer it.
 * - `auto-register`: sessions the runner starts outside the factory join it automatically.
 * - `hooks`: the harness session runs with the factory's hooks (claim-before-write, heartbeat).
 * - `headless`: runs with no desktop UI (a server, CI, a dev box).
 * - `own-hardware`: the runner is a machine its owner controls (client repos may require it).
 * - `work-item-attachments`: fetches the work item's attachments over the channel into the run's
 *   workspace, outside the git tree, and tells the agent where they are (ADR 0310). A runner
 *   without it still runs every job; its agent just sees no attachments.
 * - `steer`: a person can send a message into the live session from the dashboard (ADR 0400). The
 *   host keeps the channel's `steer` call open while the session runs and calls `adapter.steer`.
 * - `interrupt`: with `steer`, the adapter can stop the agent's current step and submit a line
 *   (`adapter.interrupt`: Escape, then the line), for a person's interrupt in planning (ADR 0470).
 * - `chat`: sessions run as a structured two-way stream (Claude Code's stream-json, ADR 0450): the
 *   events carry tool results and turn ends, the dashboard shows the run as a chat, and the owner
 *   can take a session over in a terminal by resuming it (`run.takeover`, `adapter.takeover`).
 * - `container-isolation`: each job's harness runs in its own container: only the job's repo
 *   mounted, no host credentials, an egress allowlist (ADR 0430). Planning sessions still run on
 *   the host, so a policy should require it for the other stages only.
 * - `terminal`: the live session's terminal can be bridged to the dashboard's web terminal
 *   (ADR 0440). The host keeps the channel's `terminal` call open while the session runs and, when
 *   someone watches, relays `adapter.openTerminal` over a WebSocket to the job's relay.
 */
export const CAPABILITIES = [
  "browser",
  "ui-takeover",
  "auto-register",
  "hooks",
  "headless",
  "own-hardware",
  "work-item-attachments",
  "steer",
  "chat",
  "container-isolation",
  "interrupt",
  "terminal",
  /**
   * The runner host runs the project's checks a job carries and reports them on the hand-back
   * (ADR 0501). A job with checks is placed only on a runner that declares it (ADR 0520's
   * compatibility rule): an older runner would drop the field and hand back with none.
   */
  "checks",
  "cloud-sandbox",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Harnesses a runner can start. V1 is Claude Code only. */
export const HARNESSES = ["claude-code"] as const;
export type HarnessId = (typeof HARNESSES)[number];

/** Model roles (ADR 0018). A job names a role; the cloud resolves it to a model for the harness. */
export const MODEL_ROLES = ["triage", "implement", "review", "summarise"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Stages that run on a runner. `spec` is V1's one-shot spec run (Workflow v1–v4); `planning` is the
 * live, resumable planning session (ADR 0300, Workflow v5).
 */
export const JOB_STAGES = ["triage", "spec", "planning", "build", "verify"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

/** Runner capacity pools (ADR 0301): heavy runs the test suite, light mostly reads and waits. */
export const POOLS = ["heavy", "light"] as const;
export type Pool = (typeof POOLS)[number];

/** The pool a stage's job takes a slot in (ADR 0301). */
export function stagePool(stage: JobStage): Pool {
  return stage === "build" || stage === "verify" ? "heavy" : "light";
}

/**
 * Permission modes a project may give a stage's harness (ADR 0270). No mode that prompts a person
 * (`default`/`manual`) and no `auto` (a model classifier decides, not the project's rules).
 * `bypassPermissions` only ever runs inside the harness's OS sandbox.
 */
export const HARNESS_PERMISSION_MODES = [
  "dontAsk",
  "acceptEdits",
  "bypassPermissions",
  "plan",
] as const;
export type HarnessPermissionMode = (typeof HARNESS_PERMISSION_MODES)[number];

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type Capacity = z.infer<typeof capacitySchema>;
export type CapacityPaused = NonNullable<Capacity["paused"]>;
export type Job = z.infer<typeof jobSchema>;
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type StoredArtifact = z.infer<typeof storedArtifactSchema>;
export type Handback = z.infer<typeof handbackSchema>;

/** A work item attachment the host fetched for a run (ADR 0310). Untrusted data. */
export interface AttachmentFile {
  meta: AttachmentMeta;
  bytes: Uint8Array;
}

/**
 * The runner host's local relay for a planning job (ADR 0350): the harness's planning MCP server
 * and hooks call it with the bearer token, and the host signs the call onto the channel with the
 * job's id and fencing token. The runner key never leaves the host.
 */
export interface PlanningRelay {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** Per-job secret; grants that job's planning operations and nothing else. */
  token: string;
}

/** What the host gives an adapter beyond the job itself. */
export interface PrepareOptions {
  /** For a `planning` job: where its harness reaches the planning operations. */
  planningRelay?: PlanningRelay;
}

/** What an adapter returns from prepareWorkspace. Adapters may extend it with private fields. */
export interface WorkspaceHandle {
  jobId: string;
  /** Absolute path of the checkout on the runner host. */
  path: string;
  /** The branch actually checked out. Must equal `job.branch`: one branch per run (ADR 0035). */
  branch: string;
  /** The commit the workspace started from; diffs are taken against it. */
  baseSha: string;
}

/**
 * How a session runs (ADR 0450): `terminal`, an interactive TUI in a terminal (tmux); `stream`, a
 * structured two-way stream (stream-json) the dashboard shows as a chat.
 */
export const SESSION_MODES = ["terminal", "stream"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** What an adapter returns from startSession. */
export interface SessionHandle {
  jobId: string;
  /** Opaque id meaningful to the adapter (a terminal handle, a pid, a box id…). */
  sessionRef: string;
  /** How a person can attach, when the runner declares `ui-takeover`. Shown as-is in the UI. */
  takeover?: { label: string; hint: string };
  /** How the session runs (ADR 0450). Absent: a terminal. */
  mode?: SessionMode;
}

/** Token counts for one turn of a stream session (ADR 0450): counts only, never cost or keys. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type JobState =
  | "claimed"
  | "preparing"
  | "running"
  | "collecting"
  | "handed_back"
  | "failed"
  | "released";

export type AgentStatus = "working" | "idle" | "waiting_input" | "done" | "error";
export type SessionOutcome = "completed" | "failed" | "timed_out" | "cancelled";

/** Events the adapter yields while a session runs. The host stamps them with seq + time. */
export type AdapterEvent =
  | {
      type: "session.started";
      sessionRef: string;
      takeover?: SessionHandle["takeover"];
      mode?: SessionMode;
    }
  | { type: "agent.status"; status: AgentStatus; message?: string }
  /** `screen`: the visible screen, as opposed to lines that scrolled off (ADR 0400). */
  | { type: "log"; stream: "terminal" | "stdout" | "stderr"; text: string; screen?: boolean }
  /** What the agent said (assistant) or was told (user), as the transcript has it (ADR 0400). */
  | { type: "message"; role: "assistant" | "user"; text: string }
  /** `id` pairs a stream session's tool call with its `tool.result` (ADR 0450). */
  | { type: "tool"; name: string; input?: string; id?: string }
  /** A tool call's result, from a stream session (ADR 0450). Output ≤ TOOL_OUTPUT_MAX. */
  | { type: "tool.result"; toolId: string; output: string; isError?: boolean }
  /** One turn of a stream session ended (ADR 0450). */
  | {
      type: "turn";
      outcome: "success" | "error";
      durationMs?: number;
      turns?: number;
      usage?: TurnUsage;
      error?: string;
    }
  /** A stream session stopped so a person can resume it in a terminal (ADR 0450). */
  | { type: "takeover"; sessionId: string; hint: string }
  | { type: "session.ended"; outcome: SessionOutcome; summary?: string };

/**
 * What a runner adapter implements. Claiming, signing, retries, seq numbering, the job token,
 * pushing and capacity accounting are the host's job, so an adapter is only "how to run one job
 * here".
 */
export interface RunnerAdapter<
  W extends WorkspaceHandle = WorkspaceHandle,
  S extends SessionHandle = SessionHandle,
> {
  manifest(): Promise<CapabilityManifest>;
  capacity(): Promise<Capacity>;
  /**
   * The workspace resolution rule (ADR 0260): the local checkout of `job.repo` this runner's
   * machine already has, found by canonical identity (`canonicalRepoKey`), or null when there is
   * none. The host fetches the job's base into that checkout (never writing the job token to its
   * config) instead of cloning a second copy. Optional: an adapter without a registry of checkouts
   * leaves it out and the host uses its own clone.
   */
  resolveCheckout?(job: Job): Promise<string | null>;
  /**
   * Makes the job's isolated workspace (its own worktree on `job.branch`) inside the checkout
   * `resolveCheckout` named, or the host's clone when there was none. It never registers a second
   * checkout for a repo the runner already has, and never touches the checkout's own working tree.
   */
  prepareWorkspace(job: Job, signal: AbortSignal, options?: PrepareOptions): Promise<W>;
  startSession(job: Job, workspace: W, signal: AbortSignal): Promise<S>;
  /** Yields until the session ends; the last event is `session.ended`. */
  events(job: Job, session: S, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  collectArtifacts(job: Job, workspace: W, session: S | undefined): Promise<Artifact[]>;
  /**
   * Frees everything prepareWorkspace/startSession made for this job (its worktree and branch).
   * Never the checkout or its registration, which outlive the job. Must be safe to call twice.
   * Throws `ReleaseIncomplete` when it can't confirm the job's processes stopped (ADR 0550): the
   * host then doesn't report the job released.
   */
  release(job: Job, workspace: W | undefined, session: S | undefined): Promise<void>;
  /**
   * Optional, with the `work-item-attachments` capability (ADR 0310): put the work item's files
   * into the run, outside the git tree, and return the text to add to the prompt (labelled
   * untrusted data). Called after prepareWorkspace and before startSession.
   */
  attachFiles?(job: Job, workspace: W, files: AttachmentFile[]): Promise<string>;
  /**
   * Optional: send a person's message into the live session (ADR 0400). `text` is already
   * sanitised and one line (`steerText`). Declare the `steer` capability to get steers.
   */
  steer?(session: S, text: string): Promise<void>;
  /**
   * Optional (ADR 0501): run one check command under the job's isolation (in a container, for a
   * containerised runner) and return its exit code and combined output. `dir` is a clean copy of
   * the commit being checked, made by the host (no ignored files, no git dir): the command runs
   * there, never in the session's workspace. Without `exec` the host runs checks only under its
   * own OS sandbox, and where it has none it reports them not run. Must honour `timeoutMs` and
   * `signal` (exitCode null, timedOut true on a timeout).
   */
  exec?(
    job: Job,
    workspace: W,
    command: { run: string; timeoutMs: number; dir: string },
    signal: AbortSignal,
  ): Promise<ExecResult>;
  /**
   * Optional (ADR 0501): the adapter's own tamper check of the workspace's git dir, run by the host
   * before any host git command that follows code the job ran (the checks, a fix round). Returns
   * what it found (empty when untouched); anything found fails the job without a push.
   */
  checkWorkspace?(job: Job, workspace: W): Promise<string[]>;
  /**
   * Optional (ADR 0501): after `session.ended`, give the same session another turn with `text`
   * (a failing check's command, exit code and log tail) and report that turn, ending with its own
   * `session.ended`. Only for an adapter whose session is still alive after its turn; without it
   * the host hands a failing check to a person.
   */
  continueSession?(
    job: Job,
    session: S,
    text: string,
    signal: AbortSignal,
  ): AsyncIterable<AdapterEvent>;
  /**
   * Optional, with the `interrupt` capability (ADR 0470): stop the agent's current step (Claude
   * Code's Escape), then submit `text` as `steer` does. The text is the factory's own fixed line,
   * never a person's words.
   */
  interrupt?(session: S, text: string): Promise<void>;
  /**
   * Optional, with the `chat` capability (ADR 0450): stop the live stream session cleanly so a
   * person can resume it in a terminal. `events()` then yields a `takeover` event with the command
   * and follows the resumed session until it ends; the job keeps its workspace meanwhile.
   */
  takeover?(session: S): Promise<void>;
  /**
   * Optional, with the `terminal` capability (ADR 0440): bridge the live session's terminal while
   * someone watches it from the dashboard. Output is the terminal's raw bytes; `write` types
   * whatever the person typed (the relay only forwards it from the runner's owner); `resize` sets
   * the terminal's size (only asked for by the owner: a bridge nobody resized leaves it as it is);
   * `redraw` sends the current screen as output, in order with the stream. `onExit` fires once,
   * when the session or the bridge ends. `close` must be safe to call twice.
   */
  openTerminal?(session: S, options: OpenTerminalOptions): Promise<TerminalBridge>;
}

/** What `exec` returns. */
export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  /** stdout and stderr interleaved; the host keeps only the tail. */
  output: string;
  /**
   * Set when the command was not run at all, with why (a job with no container, a sandbox that
   * could not start). Reported "not run": never a pass, and never sent to a fix round (ADR 0501).
   */
  notRun?: string;
  /**
   * Set when the check was stopped by one of the runner's own limits, with which and the limit
   * ("the check ran out of memory (limit 4 GB)"): its memory, its process count, its /tmp, its
   * disk. Reported failed with that reason (`RUNNER_LIMIT`): never a pass, and never sent to a fix
   * round the agent can't win; a person decides, as for a check not run.
   */
  limit?: string;
  /**
   * Where it ran (ADR 0501, fourth review): a check container, the OS sandbox, or the weaker OS
   * sandbox of a Mac runner whose owner opted in. Reported with the check; the gate names the last.
   */
  isolation?: "container" | "sandbox" | "weaker-sandbox";
}

/** What the host hands `openTerminal` (ADR 0440). */
export interface OpenTerminalOptions {
  /** The size to start at, when the runner's owner is watching; null leaves the terminal's own. */
  size: TerminalSize | null;
  onOutput: (bytes: Uint8Array) => void;
  /** The terminal's actual size, at start and whenever it changes. */
  onSize: (size: TerminalSize) => void;
  onExit: (reason: string) => void;
}

/** A live bridge to a session's terminal (ADR 0440). */
export interface TerminalBridge {
  write(data: string): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  redraw(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A repo's canonical identity, `github.com/<owner>/<name>`, lower-cased: the key runners match
 * existing checkouts by (ADR 0260). GitHub owner and repo names are case-insensitive.
 */
export function canonicalRepoKey(repo: { owner: string; name: string }): string {
  return `github.com/${repo.owner}/${repo.name.replace(/\.git$/, "")}`.toLowerCase();
}

/**
 * The canonical identity of a git remote URL (https, ssh or scp-like), or null when it isn't a
 * GitHub repo URL. `https://github.com/A/b.git`, `git@github.com:A/b` → `github.com/a/b`.
 */
export function canonicalKeyFromUrl(url: string): string | null {
  const m = url
    .trim()
    .match(
      /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    );
  return m?.[1] && m[2] ? canonicalRepoKey({ owner: m[1], name: m[2] }) : null;
}

/** Whether a manifest covers a job's needs; returns the missing capabilities. */
export function missingCapabilities(
  manifest: Pick<CapabilityManifest, "capabilities">,
  requires: readonly Capability[],
): Capability[] {
  const have = new Set(manifest.capabilities);
  return requires.filter((c) => !have.has(c));
}

/** Whether this runner may take the job: same contract version, the harness, every capability. */
export function canRun(
  manifest: CapabilityManifest,
  job: Pick<Job, "harness" | "requires">,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.contractVersion !== CONTRACT_VERSION) {
    return { ok: false, reason: `contract ${manifest.contractVersion} ≠ ${CONTRACT_VERSION}` };
  }
  if (!manifest.harnesses.includes(job.harness.id)) {
    return { ok: false, reason: `harness ${job.harness.id} not available` };
  }
  const missing = missingCapabilities(manifest, job.requires);
  if (missing.length > 0)
    return { ok: false, reason: `missing capabilities: ${missing.join(", ")}` };
  return { ok: true };
}

/**
 * The run branch for run `runNo` of a work item whose branch is `itemBranch` (ADR 0035):
 * `factory/<n>-<slug>` → `factory/<n>-<slug>-run-<k>`.
 */
export function runBranch(itemBranch: string, runNo: number): string {
  return `${itemBranch}-run-${runNo}`;
}

/** Whether a branch is one the factory owns (`factory/*`). Runners push nowhere else. */
export function isFactoryBranch(branch: string): boolean {
  return /^factory\/[0-9]+-[a-z0-9-]+$/.test(branch);
}

/**
 * A release that couldn't confirm the job's processes stopped (ADR 0550): the agent may still be
 * running on the host. The host doesn't report the job released (its lease lapses instead), logs
 * it, and `sf-runner doctor` shows the process.
 */
export class ReleaseIncomplete extends Error {
  override name = "ReleaseIncomplete";
  readonly releaseIncomplete = true;
}

/** Whether an error is a `ReleaseIncomplete` (across package copies too). */
export function isReleaseIncomplete(err: unknown): boolean {
  return (
    err instanceof ReleaseIncomplete ||
    (typeof err === "object" && err !== null && "releaseIncomplete" in err)
  );
}
