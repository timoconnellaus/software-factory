// The runner contract (ADR 0100, proposed). The factory schedules and runners execute: the core
// knows only this file's shapes, never a particular runner. An adapter (runner-orca, runner-local,
// later dev boxes, CF Sandbox, GitHub Actions) implements `RunnerAdapter`; the generic runner host
// (`runner-host.ts`) claims jobs over the signed channel and drives the adapter through the lifecycle:
//
//   claim job → prepare workspace (repo + branch) → start harness session → stream events
//             → collect artifacts → hand back → release
//
// Runner-specific features (UI takeover, an embedded browser, auto-registering sessions) are
// optional capabilities an adapter declares in its manifest. The scheduler only routes a job to a
// runner whose manifest covers the job's `requires`.
//
// Runtime-neutral: no Node APIs, so the cloud (Workers) and the host (Node) share it.

export const CONTRACT_VERSION = "0.1" as const;

/**
 * Optional things a runner can do beyond the core lifecycle (names from CONTEXT.md, Capability).
 * - `browser`: can open a URL in a browser it controls and take screenshots (visual evidence).
 * - `ui-takeover`: a person can attach to the live session in the runner's own UI and steer it.
 * - `auto-register`: sessions the runner starts outside the factory join it automatically.
 * - `hooks`: the harness session runs with the factory's hooks (claim-before-write, heartbeat).
 * - `headless`: runs with no desktop UI (a server, CI, a dev box).
 * - `own-hardware`: the runner is a machine its owner controls (client repos may require it).
 */
export const CAPABILITIES = [
  "browser",
  "ui-takeover",
  "auto-register",
  "hooks",
  "headless",
  "own-hardware",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Harnesses a runner can start. v1 is Claude Code only. */
export const HARNESSES = ["claude-code"] as const;
export type HarnessId = (typeof HARNESSES)[number];

export interface CapabilityManifest {
  contractVersion: typeof CONTRACT_VERSION;
  /** The adapter kind, e.g. "orca" or "local". Informational: the core never branches on it. */
  runnerKind: string;
  harnesses: HarnessId[];
  capabilities: Capability[];
}

export interface Capacity {
  /** Concurrent jobs this runner will take. */
  max: number;
  /** Jobs currently holding a workspace on this runner. */
  inUse: number;
  /** False while draining (e.g. the owner paused it); the scheduler sends nothing new. */
  accepting: boolean;
}

/** One stage job the scheduler assigned to a runner. Everything a runner needs, nothing more. */
export interface Job {
  jobId: string;
  workItemId: string;
  /** Retries of the same stage get a new attempt number and a new jobId. */
  attempt: number;
  stage: string;
  repo: {
    /** Canonical clone URL; the runner maps it to a local checkout or clones it. */
    url: string;
    baseRef: string;
  };
  /** The branch the runner must work on. The runner reports the branch it actually used. */
  branch: string;
  harness: {
    id: HarnessId;
    prompt: string;
    /** A provider model id resolved from a model role by the cloud (roles, not ids, in config). */
    model?: string;
  };
  /** Capabilities the job needs. A runner refuses a job whose needs its manifest doesn't cover. */
  requires: Capability[];
  /** Visual evidence to capture after the session, when the runner has `browser`. */
  evidence?: { screenshotUrls?: string[] };
  /** What to produce. "diff" leaves the branch local; "pr" pushes and opens a pull request. */
  output: "diff" | "pr";
  limits: { sessionTimeoutMs: number };
  lease: { leaseId: string; expiresAt: string };
}

/** What an adapter returns from prepareWorkspace. Adapters may extend it with private fields. */
export interface WorkspaceHandle {
  jobId: string;
  /** Absolute path of the checkout on the runner host. */
  path: string;
  /** The branch actually checked out (a runner may have had to rename it). */
  branch: string;
  /** The commit the workspace started from; diffs are taken against it. */
  baseSha: string;
}

/** What an adapter returns from startSession. */
export interface SessionHandle {
  jobId: string;
  /** Opaque id meaningful to the adapter (a terminal handle, a pid, a box id…). */
  sessionRef: string;
  /** How a person can attach, when the runner declares `ui-takeover`. Shown as-is in the UI. */
  takeover?: { label: string; hint: string };
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

/** Events the adapter yields while a session runs. The host stamps them with seq + time. */
export type AdapterEvent =
  | { type: "session.started"; sessionRef: string; takeover?: SessionHandle["takeover"] }
  | { type: "agent.status"; status: AgentStatus; message?: string }
  | { type: "log"; stream: "terminal" | "stdout" | "stderr"; text: string }
  | { type: "tool"; name: string; input?: string }
  | {
      type: "session.ended";
      outcome: SessionOutcome;
      summary?: string;
    };

export type SessionOutcome = "completed" | "failed" | "timed_out" | "cancelled";

/** An event on the wire: per-job monotonic seq makes delivery idempotent (cloud dedupes on it). */
export type RunnerEvent = (
  | AdapterEvent
  | { type: "job.state"; state: JobState; detail?: string }
) & {
  jobId: string;
  seq: number;
  at: string;
};

export type Artifact =
  | {
      kind: "diff";
      baseSha: string;
      headSha: string;
      branch: string;
      patch: string;
      stats: { files: number; insertions: number; deletions: number };
    }
  | { kind: "pr"; url: string; number: number; branch: string }
  | { kind: "log"; name: string; text: string }
  | { kind: "screenshot"; name: string; url: string; contentType: "image/png"; base64: string }
  | { kind: "summary"; text: string };

/** An artifact on the wire; `id` is a content hash so re-uploads are idempotent. */
export type StoredArtifact = Artifact & { id: string; jobId: string };

export interface Handback {
  jobId: string;
  outcome: SessionOutcome;
  summary?: string;
  artifactIds: string[];
  /** Where the work lives now, for the next stage or a local takeover. */
  branch?: string;
}

/**
 * What a runner adapter implements. Claiming, signing, retries, seq numbering and capacity
 * accounting are the host's job (runner-host.ts), so an adapter is only "how to run one job here".
 */
export interface RunnerAdapter<
  W extends WorkspaceHandle = WorkspaceHandle,
  S extends SessionHandle = SessionHandle,
> {
  manifest(): Promise<CapabilityManifest>;
  capacity(): Promise<Capacity>;
  prepareWorkspace(job: Job, signal: AbortSignal): Promise<W>;
  startSession(job: Job, workspace: W, signal: AbortSignal): Promise<S>;
  /** Yields until the session ends; the last event is `session.ended`. */
  events(job: Job, session: S, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  collectArtifacts(job: Job, workspace: W, session: S | undefined): Promise<Artifact[]>;
  /** Frees everything prepareWorkspace/startSession made. Must be safe to call twice. */
  release(job: Job, workspace: W | undefined, session: S | undefined): Promise<void>;
  /** Optional: send a person's message into the live session (needs `ui-takeover` or a harness that reads input). */
  steer?(session: S, text: string): Promise<void>;
}

/** Whether a manifest covers a job's needs; returns the missing capabilities. */
export function missingCapabilities(manifest: CapabilityManifest, job: Job): Capability[] {
  const have = new Set(manifest.capabilities);
  return job.requires.filter((c) => !have.has(c));
}

/** Whether this runner may take the job: same contract version, the harness, every capability. */
export function canRun(
  manifest: CapabilityManifest,
  job: Job,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.contractVersion !== CONTRACT_VERSION) {
    return { ok: false, reason: `contract ${manifest.contractVersion} ≠ ${CONTRACT_VERSION}` };
  }
  if (!manifest.harnesses.includes(job.harness.id)) {
    return { ok: false, reason: `harness ${job.harness.id} not available` };
  }
  const missing = missingCapabilities(manifest, job);
  if (missing.length > 0)
    return { ok: false, reason: `missing capabilities: ${missing.join(", ")}` };
  return { ok: true };
}
