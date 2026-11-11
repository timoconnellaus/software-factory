// The signed runner channel on sf-engine (ADR 0016, 0052; spike ADR 0100). Each call is verified
// (HMAC over method, path, body hash, timestamp and idempotency key; 5-minute window), answered from
// the D1 idempotency store when it is a replay, and otherwise mapped to ONE operation invoked as
// `{ type: "runner", id: <runner id> }`. The job token call is never stored.
import {
  type Actor,
  type AttachmentView,
  DEVICE_LOGIN_ACTOR,
  invoke,
  OperationError,
  type RefusalCode,
} from "@software-factory/core";
import {
  type AttachmentMeta,
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
import { secrets } from "./secrets.ts";

export const CHANNEL_PREFIX = "/runner/v1/";

/** HTTP status for each refusal code. 409 means "stop this job" to the host (`fenced`, `killed`). */
const STATUS: Record<RefusalCode, number> = {
  unknown_operation: 404,
  invalid_input: 400,
  forbidden: 403,
  denied: 403,
  killed: 409,
  fenced: 409,
  bad_approval: 409,
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
    ({ runner, path, body }) => route(env, runner, path, body),
  );
}

async function route(env: Env, runner: string, path: string, body: unknown): Promise<ChannelReply> {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  let op: string;
  let input: unknown;
  if (path === PATHS.heartbeat) {
    op = "runner.heartbeat";
    input = record;
  } else if (path === PATHS.claim) {
    op = "job.claim";
    input = record;
  } else {
    const job = parseJobPath(path);
    if (!job) return { status: 404, body: { error: `unknown path ${path}`, code: "not_found" } };
    if (typeof record.jobId === "string" && record.jobId !== job.jobId) {
      return {
        status: 400,
        body: { error: "jobId in the body doesn't match the path", code: "invalid_input" },
      };
    }
    input = { ...record, jobId: job.jobId };
    if (job.call === "attachments" || job.call === "attachment") {
      return attachmentReply(env, runner, job.call, input as Record<string, unknown>);
    }
    op = {
      token: "run.issueToken",
      events: "run.reportEvents",
      artifacts: "run.addArtifact",
      handback: "run.handBack",
      release: "run.release",
    }[job.call];
  }
  return invokeReply(env, op, input, { type: "runner", id: runner });
}

/**
 * The run's view of its work item's attachments (ADR 0260): `workItem.attachment.list` / `.get`
 * as the runner, scoped by the job and its fencing token, answered in the wire shapes
 * (`attachmentsResponseSchema`, `attachmentResponseSchema`: the bytes as base64).
 */
async function attachmentReply(
  env: Env,
  runner: string,
  call: "attachments" | "attachment",
  record: Record<string, unknown>,
): Promise<ChannelReply> {
  const meta = (a: AttachmentView): AttachmentMeta => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    createdAt: a.createdAt,
  });
  const actor: Actor = { type: "runner", id: runner };
  const input =
    call === "attachments"
      ? { jobId: record.jobId, fencingToken: record.fencingToken }
      : {
          jobId: record.jobId,
          fencingToken: record.fencingToken,
          attachmentId: record.attachmentId,
        };
  const reply = await invokeReply(
    env,
    call === "attachments" ? "workItem.attachment.list" : "workItem.attachment.get",
    input,
    actor,
  );
  if (reply.status && reply.status !== 200) return reply;
  if (call === "attachments") {
    const out = reply.body as { attachments: AttachmentView[] };
    return { body: { attachments: out.attachments.map(meta) } };
  }
  const out = reply.body as { attachment: AttachmentView; bytes: Uint8Array };
  return {
    body: { attachment: meta(out.attachment), base64: toBase64(out.bytes) },
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
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
): Promise<ChannelReply> {
  try {
    const result = await invoke(invokeDeps(env), op, input, {
      actor,
      origin: { surface: "runner-channel" },
    });
    if (result.status === "pending") {
      return { status: 202, body: { pending: true, pendingActionId: result.pendingActionId } };
    }
    return { body: result.output };
  } catch (error) {
    if (error instanceof OperationError) {
      return {
        status: STATUS[error.code],
        body: {
          error: error.message,
          code: error.code,
          ...(error.code === "invalid_input" ? { details: error.details } : {}),
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
  await db
    .prepare("DELETE FROM core_channel_requests WHERE at < ?")
    .bind(new Date(now.getTime() - 24 * 3_600_000).toISOString())
    .run();
}
