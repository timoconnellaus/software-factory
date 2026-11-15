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
import type {
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
 * Capability names a runner may declare. What this code declares (names from CONTEXT.md, Capability):
 * - `hooks`: the harness session runs with the factory's hooks (status from Claude Code's hooks).
 * - `ui-takeover`: a person can attach to the live session on the runner's own machine (tmux).
 * - `own-hardware`: the runner is a machine its owner controls.
 * - `chat`: sessions run as a structured stream (Claude Code's stream-json, ADR 0450): the events
 *   carry tool results and turn ends (the run view's steps and token counts).
 * - `flow`: the runner host runs a `flow` job, the new core's run (spec 70). A flow run is offered
 *   only to a runner that declares it.
 *
 * The others were the old pipeline's (spec 70 milestone 5 removed it). They stay in the list only
 * so that a runner still on older code, which declares them, is not refused by the engine's schema
 * before it has updated itself (ADR 0520: an enum may only grow). Nothing acts on them.
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
  "checks",
  "cloud-sandbox",
  "babysit",
  "job-line",
  "flow",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Harnesses a runner can start. V1 is Claude Code only. */
export const HARNESSES = ["claude-code"] as const;
export type HarnessId = (typeof HARNESSES)[number];

/** Model roles (ADR 0018). A job names a role; the cloud resolves it to a model for the harness. */
export const MODEL_ROLES = ["triage", "implement", "review", "summarise"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * The one stage that runs on a runner: `flow` (spec 70, ADR 0660), an agent-owned status in the new
 * core. It may have no repository (writing, research): no repo, branch, token or push; the session
 * works in a plain directory. Either way it hands back `flowResultSchema`.
 */
export const JOB_STAGES = ["flow"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type Capacity = z.infer<typeof capacitySchema>;
export type CapacityPaused = NonNullable<Capacity["paused"]>;
export type Job = z.infer<typeof jobSchema>;
/** A `flow` job with a repository and its item's branch. */
export type RepoJob = Job & { repo: NonNullable<Job["repo"]>; branch: string };

/** Whether the job works in a repository. */
export function hasRepo(job: Job): job is RepoJob {
  return job.repo !== undefined && job.branch !== undefined;
}
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type StoredArtifact = z.infer<typeof storedArtifactSchema>;
export type Handback = z.infer<typeof handbackSchema>;

/** What an adapter returns from prepareWorkspace. Adapters may extend it with private fields. */
export interface WorkspaceHandle {
  jobId: string;
  /** Absolute path of the checkout on the runner host. */
  path: string;
  /** The branch actually checked out. Must equal `job.branch` (empty for a job without a repo). */
  branch: string;
  /** The commit the workspace started from; diffs are taken against it. */
  baseSha: string;
}

/**
 * How a session runs (ADR 0450): `terminal`, an interactive TUI in a terminal (tmux); `stream`, a
 * structured stream (stream-json) whose events carry tool results and token counts.
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
  prepareWorkspace(job: Job, signal: AbortSignal): Promise<W>;
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
 * A `flow` job with a repository (spec 70) works on, and pushes, its item's branch:
 * `factory/flow-<lower-cased project key>-<item number>`, one branch for every run on the item, one
 * level under `factory/`: GitHub's ruleset pattern `refs/heads/factory/**` matches a single level
 * only (a push to `factory/flow/sf-1` was refused on 2026-11-15).
 */
export function isFlowBranch(branch: string): boolean {
  return /^factory\/flow-[a-z0-9][a-z0-9-]*-[0-9]+$/.test(branch);
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
