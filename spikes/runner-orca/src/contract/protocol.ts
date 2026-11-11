// The calls a runner host makes to the cloud over the signed channel (ADR 0100). All are POSTs
// from the host (outbound only). Each one is idempotent under its idempotency key, and the keys
// are derived from the call's meaning, so a host that crashes and retries sends the same key:
//
//   heartbeat   hb:<runner>:<uuid>            manifest + capacity in; commands (cancel/steer) out
//   claim       claim:<runner>:<claimId>      returns the same job for the same claimId
//   events      ev:<job>:<firstSeq>-<lastSeq> the cloud also dedupes each event on (job, seq)
//   artifacts   art:<job>:<artifact id>       artifact ids are content hashes
//   handback    hand:<job>
//   release     rel:<job>

import { sha256Hex, signRunnerRequest } from "./channel.ts";
import type {
  CapabilityManifest,
  Capacity,
  Handback,
  Job,
  JobState,
  RunnerEvent,
  StoredArtifact,
} from "./types.ts";

export const PATHS = {
  heartbeat: "/runner/v1/heartbeat",
  claim: "/runner/v1/claim",
  events: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/events`,
  artifacts: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/artifacts`,
  handback: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/handback`,
  release: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/release`,
} as const;

export interface HeartbeatRequest {
  manifest: CapabilityManifest;
  capacity: Capacity;
  /** Jobs the host still holds, so the cloud can spot ones it thinks are elsewhere. */
  activeJobIds: string[];
}

export type RunnerCommand =
  | { kind: "cancel"; jobId: string; reason: string }
  | { kind: "steer"; jobId: string; text: string }
  | { kind: "drain" };

export interface HeartbeatResponse {
  commands: RunnerCommand[];
}

export interface ClaimRequest {
  /** Host-generated; a retry of the same claim reuses it and gets the same job back. */
  claimId: string;
  capacity: Capacity;
  manifest: CapabilityManifest;
}

export interface ClaimResponse {
  job: Job | null;
}

export interface ReleaseRequest {
  jobId: string;
  finalState: Extract<JobState, "handed_back" | "failed">;
  reason?: string;
}

/** The host's view of the cloud. The real one is HTTP (below); tests use an in-memory one. */
export interface ControlPlaneClient {
  heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse>;
  claim(body: ClaimRequest): Promise<ClaimResponse>;
  events(jobId: string, events: RunnerEvent[]): Promise<void>;
  artifacts(jobId: string, artifacts: StoredArtifact[]): Promise<void>;
  handback(body: Handback): Promise<void>;
  release(body: ReleaseRequest): Promise<void>;
}

/** Content-hash id for an artifact, so uploading it twice is a no-op. */
export async function artifactId(artifact: object): Promise<string> {
  return `a_${(await sha256Hex(JSON.stringify(artifact))).slice(0, 32)}`;
}

/** A ControlPlaneClient over HTTPS with signed requests. */
export function httpControlPlane(config: {
  baseUrl: string;
  runnerId: string;
  key: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): ControlPlaneClient {
  const doFetch = config.fetch ?? fetch;
  async function call<T>(path: string, idempotencyKey: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const headers = await signRunnerRequest({
      key: config.key,
      runner: config.runnerId,
      method: "POST",
      path,
      body,
      idempotencyKey,
      ...(config.now ? { now: config.now() } : {}),
    });
    const response = await doFetch(new URL(path, config.baseUrl), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }
  return {
    // A heartbeat is a report, not an action: each one is new, so each gets a fresh key.
    heartbeat: (body) =>
      call(PATHS.heartbeat, `hb:${config.runnerId}:${crypto.randomUUID()}`, body),
    claim: (body) => call(PATHS.claim, `claim:${config.runnerId}:${body.claimId}`, body),
    events: async (jobId, events) => {
      const first = events[0]?.seq ?? 0;
      const last = events.at(-1)?.seq ?? first;
      await call(PATHS.events(jobId), `ev:${jobId}:${first}-${last}`, { events });
    },
    artifacts: async (jobId, artifacts) => {
      for (const artifact of artifacts) {
        await call(PATHS.artifacts(jobId), `art:${jobId}:${artifact.id}`, { artifact });
      }
    },
    handback: async (body) => {
      await call(PATHS.handback(body.jobId), `hand:${body.jobId}`, body);
    },
    release: async (body) => {
      await call(PATHS.release(body.jobId), `rel:${body.jobId}`, body);
    },
  };
}
