// The calls a runner host makes to the cloud over the signed channel (ADR 0016, 0100, 0052). All
// are POSTs from the host (outbound only). Each one is idempotent under its idempotency key, and
// the keys are derived from the call's meaning, so a host that crashes and retries sends the same
// key:
//
//   heartbeat   hb:<runner>:<uuid>             manifest + capacity + active jobs in; commands out
//   claim       claim:<runner>:<claimId>       returns the same job for the same claimId
//   token       tok:<job>:<uuid>               NOT stored: a fresh job token per call
//   events      ev:<job>:<firstSeq>-<lastSeq>  the cloud also dedupes each event on (job, seq)
//   artifacts   art:<job>:<artifact id>        artifact ids are content hashes
//   handback    hand:<job>
//   release     rel:<job>
//
// Every job-scoped call carries the job's fencing token; after a takeover or a lost lease the cloud
// answers 409 with code `fenced`, and the host must stop the run (ADR 0035).

import { sha256Hex, signRunnerRequest, verifyRunnerResponse } from "./channel.ts";
import type { Handback, StoredArtifact } from "./types.ts";
import type {
  ClaimRequest,
  ClaimResponse,
  EventsRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  ReleaseRequest,
  TokenResponse,
} from "./wire.ts";

export const PATHS = {
  heartbeat: "/runner/v1/heartbeat",
  claim: "/runner/v1/claim",
  token: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/token`,
  events: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/events`,
  artifacts: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/artifacts`,
  handback: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/handback`,
  release: (jobId: string) => `/runner/v1/jobs/${encodeURIComponent(jobId)}/release`,
} as const;

/**
 * Device login (ADR 0056): the two calls `sf-runner login` makes before it has a key. Unsigned;
 * the device code in the body is the CLI's secret. Bodies: `{ name? }` → `{ deviceCode, userCode,
 * expiresAt, interval }`, and `{ deviceCode }` → `{ status, runnerId, name, keyVersion, key }`.
 */
export const DEVICE_PATHS = {
  start: "/runner/v1/device/start",
  poll: "/runner/v1/device/poll",
} as const;

/** Where a person approves a device login code, on the app. */
export const DEVICE_APPROVE_PATH = "/runners/connect";

/** Job-scoped calls, as the path's last segment. */
export const JOB_CALLS = ["token", "events", "artifacts", "handback", "release"] as const;
export type JobCall = (typeof JOB_CALLS)[number];

/** Parses `/runner/v1/jobs/<id>/<call>`. */
export function parseJobPath(path: string): { jobId: string; call: JobCall } | null {
  const match = path.match(/^\/runner\/v1\/jobs\/([^/]+)\/([a-z]+)$/);
  if (!match) return null;
  const call = match[2] as JobCall;
  if (!JOB_CALLS.includes(call)) return null;
  return { jobId: decodeURIComponent(match[1] ?? ""), call };
}

/** Calls whose responses the cloud never stores (they carry a secret). */
export function isUnstoredPath(path: string): boolean {
  return parseJobPath(path)?.call === "token";
}

/** A refused channel call. `code` is the cloud's refusal code (`fenced`, `killed`, …). */
export class ChannelCallError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`${path}: HTTP ${status} ${message}`);
    this.name = "ChannelCallError";
  }
}

/** The host's view of the cloud. The real one is HTTP (below); tests may use an in-memory one. */
export interface ControlPlaneClient {
  heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse>;
  claim(body: ClaimRequest): Promise<ClaimResponse>;
  token(jobId: string, fencingToken: number): Promise<TokenResponse>;
  events(jobId: string, body: EventsRequest): Promise<void>;
  artifact(jobId: string, fencingToken: number, artifact: StoredArtifact): Promise<void>;
  handback(body: Handback): Promise<void>;
  release(body: ReleaseRequest): Promise<void>;
}

/** Content-hash id for an artifact, so uploading it twice is a no-op. */
export async function artifactId(artifact: object): Promise<string> {
  return `a_${(await sha256Hex(JSON.stringify(artifact))).slice(0, 32)}`;
}

/** A ControlPlaneClient over HTTPS with signed requests and verified responses. */
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
    if (!response.ok) {
      const text = await response.text();
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { code?: string }).code;
      } catch {
        code = undefined;
      }
      throw new ChannelCallError(path, response.status, code, text);
    }
    const verified = await verifyRunnerResponse(response, {
      key: config.key,
      runner: config.runnerId,
      path,
      idempotencyKey,
      ...(config.now ? { now: config.now() } : {}),
    });
    if (!verified.ok) throw new Error(`${path}: ${verified.reason}`);
    return JSON.parse(verified.body) as T;
  }
  return {
    // A heartbeat is a report, not an action: each one is new, so each gets a fresh key.
    heartbeat: (body) =>
      call(PATHS.heartbeat, `hb:${config.runnerId}:${crypto.randomUUID()}`, body),
    claim: (body) => call(PATHS.claim, `claim:${config.runnerId}:${body.claimId}`, body),
    token: (jobId, fencingToken) =>
      call(PATHS.token(jobId), `tok:${jobId}:${crypto.randomUUID()}`, { fencingToken }),
    events: async (jobId, body) => {
      const first = body.events[0]?.seq ?? 0;
      const last = body.events.at(-1)?.seq ?? first;
      await call(PATHS.events(jobId), `ev:${jobId}:${first}-${last}`, body);
    },
    artifact: async (jobId, fencingToken, artifact) => {
      await call(PATHS.artifacts(jobId), `art:${jobId}:${artifact.id}`, {
        fencingToken,
        artifact,
      });
    },
    handback: async (body) => {
      await call(PATHS.handback(body.jobId), `hand:${body.jobId}`, body);
    },
    release: async (body) => {
      await call(PATHS.release(body.jobId), `rel:${body.jobId}`, body);
    },
  };
}
