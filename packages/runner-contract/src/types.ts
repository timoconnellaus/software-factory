// The runner contract (ADR 0014, ADR 0100). The factory schedules and runners execute: the core knows
// only these shapes, never a particular runner. An adapter (runner-orca, runner-local, later dev
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

export const CONTRACT_VERSION = "1" as const;

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

/** Harnesses a runner can start. V1 is Claude Code only. */
export const HARNESSES = ["claude-code"] as const;
export type HarnessId = (typeof HARNESSES)[number];

/** Model roles (ADR 0018). A job names a role; the cloud resolves it to a model for the harness. */
export const MODEL_ROLES = ["triage", "implement", "review", "summarise"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** Stages that run on a runner. */
export const JOB_STAGES = ["triage", "spec", "build", "verify"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type Capacity = z.infer<typeof capacitySchema>;
export type Job = z.infer<typeof jobSchema>;
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type StoredArtifact = z.infer<typeof storedArtifactSchema>;
export type Handback = z.infer<typeof handbackSchema>;

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
export type SessionOutcome = "completed" | "failed" | "timed_out" | "cancelled";

/** Events the adapter yields while a session runs. The host stamps them with seq + time. */
export type AdapterEvent =
  | { type: "session.started"; sessionRef: string; takeover?: SessionHandle["takeover"] }
  | { type: "agent.status"; status: AgentStatus; message?: string }
  | { type: "log"; stream: "terminal" | "stdout" | "stderr"; text: string }
  | { type: "tool"; name: string; input?: string }
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
  prepareWorkspace(job: Job, signal: AbortSignal): Promise<W>;
  startSession(job: Job, workspace: W, signal: AbortSignal): Promise<S>;
  /** Yields until the session ends; the last event is `session.ended`. */
  events(job: Job, session: S, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  collectArtifacts(job: Job, workspace: W, session: S | undefined): Promise<Artifact[]>;
  /** Frees everything prepareWorkspace/startSession made. Must be safe to call twice. */
  release(job: Job, workspace: W | undefined, session: S | undefined): Promise<void>;
  /** Optional: send a person's message into the live session. */
  steer?(session: S, text: string): Promise<void>;
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
