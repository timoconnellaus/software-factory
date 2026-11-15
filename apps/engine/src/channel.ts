// The signed runner channel on sf-engine (ADR 0016, 0052; spike ADR 0100). Each call is verified
// (HMAC over method, path, body hash, timestamp and idempotency key; 5-minute window) and answered
// from the D1 idempotency store when it is a replay. The heartbeat and the claim report the runner's
// state through the platform's operations, as `{ type: "runner", id: <runner id> }`; the jobs are
// the new core's flow runs (flow/channel.ts). The job token call is never stored.
import {
  type Actor,
  DEVICE_LOGIN_ACTOR,
  invoke,
  OperationError,
  type RefusalCode,
} from "@software-factory/core";
import {
  type ChannelReply,
  DEVICE_PATHS,
  handleRunnerCall,
  type IdempotencyBegin,
  type IdempotencyStore,
  isUnstoredPath,
  PATHS,
  parseJobPath,
  runnerChannelKey,
} from "@software-factory/runner-contract";
import { invokeDeps } from "./deps.ts";
import { beatFlowJobs, claimFlowJob, flowJobReply, isFlowJob } from "./flow/channel.ts";
import { secrets } from "./secrets.ts";

export const CHANNEL_PREFIX = "/runner/v1/";

/** HTTP status for each refusal code. */
export const STATUS: Record<RefusalCode, number> = {
  unknown_operation: 404,
  invalid_input: 400,
  forbidden: 403,
  denied: 403,
  conflict: 409,
  not_found: 404,
  unavailable: 503,
};

export async function handleChannel(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const { pathname } = new URL(request.url);
  if (pathname === DEVICE_PATHS.start || pathname === DEVICE_PATHS.poll) {
    return handleDeviceLogin(request, env, pathname);
  }
  const secret = secrets(env).RUNNER_CHANNEL_SECRET;
  if (!secret) {
    return Response.json(
      { error: "the runner channel is not configured", code: "unavailable" },
      { status: 503 },
    );
  }
  const keyFor = async (runner: string) => {
    const row = await env.DB.prepare(
      "SELECT key_version, revoked_at FROM core_runners WHERE id = ?",
    )
      .bind(runner)
      .first<{ key_version: number; revoked_at: string | null }>();
    if (!row || row.revoked_at) return null;
    return runnerChannelKey(secret, runner, row.key_version);
  };
  return handleRunnerCall(
    request,
    { keyFor, store: d1IdempotencyStore(env.DB), unstoredPath: isUnstoredPath },
    ({ runner, path, body, signedAt }) =>
      route(env, runner, path, body, new URL(request.url).origin, signedAt),
  );
}

async function route(
  env: Env,
  runner: string,
  path: string,
  body: unknown,
  origin: string,
  signedAt?: number,
): Promise<ChannelReply> {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const actor: Actor = { type: "runner", id: runner };
  if (path === PATHS.heartbeat) return heartbeatReply(env, runner, record, signedAt);
  if (path === PATHS.claim) {
    // The new core's queued runs; then the runner's report is recorded (runner.claim), which also
    // keeps a claim replayed within the signing window from claiming again.
    // A failure here still answers the claim (no job), so the runner keeps polling.
    const flowJob = await claimFlowJob(env, runner, record, signedAt, origin).catch((error) => {
      console.error("flow claim failed", error);
      return null;
    });
    if (flowJob) return { body: { job: flowJob } };
    // Unstored: its signed time keeps a replayed one from changing state (ADR 0016, 0590).
    return invokeReply(env, "runner.claim", record, actor, signedAt);
  }
  const job = parseJobPath(path);
  if (!job) return { status: 404, body: { error: `unknown path ${path}`, code: "not_found" } };
  if (typeof record.jobId === "string" && record.jobId !== job.jobId) {
    return {
      status: 400,
      body: { error: "jobId in the body doesn't match the path", code: "invalid_input" },
    };
  }
  if (isFlowJob(job.jobId)) return flowJobReply(env, runner, job.jobId, job.call, record);
  // Every job is a flow run now: anything else is one of the old core's, which are gone.
  return { status: 404, body: { error: `no job ${job.jobId}`, code: "not_found" } };
}

/**
 * The heartbeat: the flow jobs it holds have their leases renewed by the new core, then
 * runner.heartbeat records the runner's report and answers its version and commands (a cancel for
 * any other held job). Unstored: its signed time keeps a replayed one from changing the runner's
 * state (ADR 0016, 0590).
 */
async function heartbeatReply(
  env: Env,
  runner: string,
  record: Record<string, unknown>,
  signedAt?: number,
): Promise<ChannelReply> {
  const active = Array.isArray(record.activeJobs) ? (record.activeJobs as unknown[]) : null;
  const isFlow = (j: unknown) =>
    typeof (j as { jobId?: unknown } | null)?.jobId === "string" &&
    isFlowJob((j as { jobId: string }).jobId);
  const flowHeld = (active ?? []).filter(isFlow) as { jobId: string; fencingToken: number }[];
  const input = active ? { ...record, activeJobs: active.filter((j) => !isFlow(j)) } : record;
  const reply = await invokeReply(
    env,
    "runner.heartbeat",
    input,
    { type: "runner", id: runner },
    signedAt,
  );
  if (flowHeld.length === 0 || (reply.status && reply.status !== 200)) return reply;
  const flow = await beatFlowJobs(env, runner, flowHeld);
  const out = reply.body as { leases: unknown[]; commands: unknown[] };
  return {
    body: {
      ...out,
      commands: [...out.commands, ...flow.commands],
      leases: [...out.leases, ...flow.leases],
    },
  };
}

/**
 * The two unsigned device-login calls (ADR 0056): the CLI has no key yet. They run as
 * DEVICE_LOGIN_ACTOR, which no signed runner can be (runner ids are `r_…`).
 */
async function handleDeviceLogin(request: Request, env: Env, path: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body is not JSON", code: "invalid_input" }, { status: 400 });
  }
  const op = path === DEVICE_PATHS.start ? "runner.deviceStart" : "runner.devicePoll";
  const reply = await invokeReply(env, op, body, DEVICE_LOGIN_ACTOR);
  return Response.json(reply.body, {
    status: reply.status ?? 200,
    headers: { "cache-control": "no-store" },
  });
}

async function invokeReply(
  env: Env,
  op: string,
  input: unknown,
  actor: Actor,
  signedAt?: number,
): Promise<ChannelReply> {
  try {
    const result = await invoke(invokeDeps(env), op, input, {
      actor,
      origin: { surface: "runner-channel", ...(signedAt !== undefined ? { signedAt } : {}) },
    });
    return { body: result.output };
  } catch (error) {
    if (error instanceof OperationError) {
      return {
        status: STATUS[error.code],
        body: {
          error: error.message,
          code: error.code,
          ...(error.code === "invalid_input" ? { details: error.details } : {}),
          // A lost race (a batch guard or unique key), which a retry may win.
          ...(error.details?.raced === true ? { raced: true } : {}),
        },
      };
    }
    throw error;
  }
}

/**
 * The channel's idempotency store in D1 (spike open question 4): `begin` claims the key with
 * INSERT … ON CONFLICT DO NOTHING, so two simultaneous identical calls can't both run.
 */
export function d1IdempotencyStore(db: D1Database): IdempotencyStore {
  return {
    async begin(runner, key, bodyHash): Promise<IdempotencyBegin> {
      const inserted = await db
        .prepare(
          `INSERT INTO core_channel_requests (runner_id, idempotency_key, body_hash, status, at)
           VALUES (?, ?, ?, 'pending', ?) ON CONFLICT (runner_id, idempotency_key) DO NOTHING`,
        )
        .bind(runner, key, bodyHash, new Date().toISOString())
        .run();
      if (inserted.meta.changes > 0) return { state: "new" };
      const row = await db
        .prepare(
          "SELECT body_hash, status, response_status, response FROM core_channel_requests WHERE runner_id = ? AND idempotency_key = ?",
        )
        .bind(runner, key)
        .first<{
          body_hash: string;
          status: string;
          response_status: number | null;
          response: string | null;
        }>();
      if (!row) return { state: "new" };
      if (row.body_hash !== bodyHash) return { state: "conflict" };
      if (row.status !== "done") return { state: "in_progress" };
      return {
        state: "replay",
        status: row.response_status ?? 200,
        response: row.response ?? "null",
      };
    },
    async complete(runner, key, status, response) {
      await db
        .prepare(
          "UPDATE core_channel_requests SET status = 'done', response_status = ?, response = ? WHERE runner_id = ? AND idempotency_key = ?",
        )
        .bind(status, response, runner, key)
        .run();
    },
    async abandon(runner, key) {
      await db
        .prepare("DELETE FROM core_channel_requests WHERE runner_id = ? AND idempotency_key = ?")
        .bind(runner, key)
        .run();
    },
  };
}

/** Stored answers are kept a day: far past the 5-minute window and any host retry. */
export async function pruneChannelStore(db: D1Database, now = new Date()): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM core_channel_requests WHERE at < ?").bind(dayAgo),
    // The desktop app's sign-in requests and presence challenges (spec 40 M1): kept a day past
    // their expiry for the audit's sake, then gone. Devices and tokens stay (they're revocable).
    db.prepare("DELETE FROM core_desktop_auth_requests WHERE expires_at < ?").bind(dayAgo),
    db.prepare("DELETE FROM core_presence_challenges WHERE expires_at < ?").bind(dayAgo),
    // The phone's attestation nonces, spent pair offers and typed-code tries (ADR 0541), likewise.
    db.prepare("DELETE FROM core_mobile_nonces WHERE expires_at < ?").bind(dayAgo),
    db.prepare("DELETE FROM core_pair_offers WHERE expires_at < ?").bind(dayAgo),
    db.prepare("DELETE FROM core_pair_code_tries WHERE at < ?").bind(dayAgo),
  ]);
}
