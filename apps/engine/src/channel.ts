// The signed runner channel on sf-engine (ADR 0016, 0052; spike ADR 0100). Each call is verified
// (HMAC over method, path, body hash, timestamp and idempotency key; 5-minute window), answered from
// the D1 idempotency store when it is a replay, and otherwise mapped to ONE operation invoked as
// `{ type: "runner", id: <runner id> }`. The job token call is never stored.
import {
  type Actor,
  type AttachmentView,
  DEVICE_LOGIN_ACTOR,
  invoke,
  OPEN_SESSION,
  OperationError,
  type RefusalCode,
  USER_EVENTS,
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
  PLANNING_WAIT_MAX_MS,
  parseJobPath,
  planningCallRequestSchema,
  runnerChannelKey,
  STEER_WAIT_MAX_MS,
  steersRequestSchema,
  TERMINAL_PATHS,
  TERMINAL_TICKET_TTL_MS,
  TERMINAL_WAIT_MAX_MS,
  terminalCallRequestSchema,
} from "@software-factory/runner-contract";
import { invokeDeps } from "./deps.ts";
import { secrets } from "./secrets.ts";
import { terminalRelay } from "./terminal-relay.ts";

export const CHANNEL_PREFIX = "/runner/v1/";

/** HTTP status for each refusal code. 409 means "stop this job" to the host (`fenced`, `killed`). */
export const STATUS: Record<RefusalCode, number> = {
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
    ({ runner, path, body, signedAt }) =>
      route(env, runner, path, body, new URL(request.url).origin, signedAt, request.signal),
  );
}

async function route(
  env: Env,
  runner: string,
  path: string,
  body: unknown,
  origin: string,
  signedAt?: number,
  /** The request's: a held call stops when the host has gone, so nothing is taken for nobody. */
  signal?: AbortSignal,
): Promise<ChannelReply> {
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
    if (job.call === "planning") return planningReply(env, runner, job.jobId, record, signal);
    if (job.call === "steer") return steerReply(env, runner, job.jobId, record, signal);
    if (job.call === "terminal") {
      return terminalReply(env, runner, job.jobId, record, origin, signal);
    }
    if (job.call === "line") return lineReply(env, runner, job.jobId, record, origin);
    op = {
      token: "run.issueToken",
      events: "run.reportEvents",
      artifacts: "run.addArtifact",
      handback: "run.handBack",
      release: "run.release",
    }[job.call];
  }
  // The heartbeat and the claim are unstored: their signed time keeps a replayed one from changing
  // state (ADR 0016, 0590).
  return invokeReply(
    env,
    op,
    input,
    { type: "runner", id: runner },
    path === PATHS.heartbeat || path === PATHS.claim ? signedAt : undefined,
  );
}

/**
 * The run's view of its work item's attachments (ADR 0310): `workItem.attachment.list` / `.get`
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
 * A planning job's operation (ADR 0350), relayed by the runner host for its harness: one operation
 * from the allowlist, as the runner, with the job id from the path. `planning.wait` is held here: it
 * is evaluated, then held in the Worker polling planning.peek (spec 44) until news is due, the
 * session must yield or end, or the wait's time is up.
 */
async function planningReply(
  env: Env,
  runner: string,
  jobId: string,
  record: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChannelReply> {
  const parsed = planningCallRequestSchema.safeParse(record);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.message, code: "invalid_input", details: parsed.error.issues },
    };
  }
  const { op, fencingToken } = parsed.data;
  const input: Record<string, unknown> = { ...parsed.data.input, jobId, fencingToken };
  const actor: Actor = { type: "runner", id: runner };
  if (op !== "planning.wait") return invokeReply(env, op, input, actor);

  const timeout = Math.min(
    typeof input.timeoutMs === "number" ? input.timeoutMs : PLANNING_WAIT_MAX_MS,
    PLANNING_WAIT_MAX_MS,
  );
  const deadline = Date.now() + timeout;
  type Waited = {
    workItemId: string;
    cursor: number;
    due: boolean;
    yield: boolean;
    ended: boolean;
    recheckAt: string | null;
  };
  // planning.wait (fenced) first. While nothing is due, the wait is in the Worker (spec 44 part
  // A3): every HELD_POLL_MS one raw read says whether anything is pending for the agent (a
  // person's news after the cursor) and whether the session must yield or has ended. Only on a
  // new pending event does it call planning.peek (fenced) for when that news falls due; it calls
  // planning.wait again once it is due, the session must yield or has ended, or the hold ends.
  let reply = await invokeReply(env, op, input, actor);
  for (;;) {
    if (reply.status && reply.status !== 200) return reply;
    const body = reply.body as Waited;
    if (body.due || body.yield || body.ended || Date.now() >= deadline) return reply;
    let recheck = body.recheckAt ? Date.parse(body.recheckAt) : Number.POSITIVE_INFINITY;
    let peeked = 0;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) break;
      await pause(Math.min(HELD_POLL_MS, left, Math.max(0, recheck - Date.now())));
      if (signal?.aborted) {
        heldAborted("planning", jobId, deadline - timeout);
        return { body: { ...body, due: false } };
      }
      if (Date.now() >= recheck || Date.now() >= deadline) break;
      const state = await env.DB.prepare(
        `SELECT s.status, s.yield_requested_at,
           (SELECT max(e.id) FROM core_planning_events e
            WHERE e.work_item_id = s.work_item_id AND e.id > max(?, s.delivered_cursor)
              AND e.type IN (${USER_EVENTS.map(() => "?").join(", ")})) AS pending
         FROM core_planning_sessions s
         WHERE s.work_item_id = ? AND s.status NOT IN ('ended', 'moved') LIMIT 1`,
      )
        .bind(body.cursor ?? 0, ...USER_EVENTS, body.workItemId)
        .first<{ status: string; yield_requested_at: string | null; pending: number | null }>();
      if (!state || state.yield_requested_at || !OPEN_SESSION.includes(state.status)) break;
      if (!state.pending || state.pending <= peeked) continue;
      // A new event a person made: when does the batch fall due?
      peeked = state.pending;
      const peek = await invokeReply(
        env,
        "planning.peek",
        {
          jobId,
          fencingToken,
          ...(typeof input.cursor === "number" ? { cursor: input.cursor } : {}),
          ...(typeof input.idleMs === "number" ? { idleMs: input.idleMs } : {}),
        },
        actor,
      );
      if (peek.status && peek.status !== 200) return peek;
      const p = peek.body as { dueAt: string | null; yield: boolean; ended: boolean };
      if (p.yield || p.ended) break;
      if (p.dueAt) recheck = Math.min(recheck, Date.parse(p.dueAt));
      if (Date.now() >= recheck) break;
    }
    if (signal?.aborted) return reply;
    reply = await invokeReply(env, op, input, actor);
    const again = reply.body as Waited | undefined;
    if (reply.status && reply.status !== 200) return reply;
    if (again && !again.due && !again.yield && !again.ended && Date.now() < deadline) continue;
    return reply;
  }
}

/**
 * How often a held channel call re-checks while it waits (spec 44 part A). The wait is in the
 * Worker, which is billed for CPU and not for wall time; each check is one indexed point read on a
 * partial index that is empty while nothing is due. No Durable Object is held.
 */
export const HELD_POLL_MS = 3_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * The runner host's held steer call (spec 31, ADR 0400; spec 44 part A): `run.takeSteers` as the
 * runner (fenced) first. While nothing is queued, the call waits in the Worker, reading every
 * HELD_POLL_MS whether the run has an undelivered steer (core_run_steers_undelivered_idx), and takes
 * them once one is there. When the time is up it answers empty without another take. Taking steers
 * marks them delivered, in the operation's own guarded batch, so a steer is handed over once.
 */
async function steerReply(
  env: Env,
  runner: string,
  jobId: string,
  record: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChannelReply> {
  const parsed = steersRequestSchema.safeParse(record);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.message, code: "invalid_input", details: parsed.error.issues },
    };
  }
  const { fencingToken } = parsed.data;
  const timeout = Math.min(parsed.data.waitMs ?? STEER_WAIT_MAX_MS, STEER_WAIT_MAX_MS);
  const started = Date.now();
  const deadline = started + timeout;
  const actor: Actor = { type: "runner", id: runner };
  // A host that acks (spec 44 host ack) sends `ack` on every call: its acks go with the first
  // take, and every take stays in acking mode (offers, never deliveries) with `ack: []`.
  const acking = parsed.data.ack !== undefined;
  let ack = parsed.data.ack ?? [];
  // A take that lost a race to another (two calls read the same queued steer; the guard lets one
  // hand it over) is tried again: the host never sees that 409, which it would take as "this job
  // can't be steered" and stop asking (review of #179).
  const take = async () => {
    for (let attempt = 0; ; attempt++) {
      const reply = await invokeReply(
        env,
        "run.takeSteers",
        { jobId, fencingToken, ...(acking ? { ack } : {}) },
        actor,
      );
      if (!(reply.body as { raced?: boolean } | undefined)?.raced) {
        if (!reply.status || reply.status === 200) ack = [];
        return reply;
      }
      // Still racing after a few tries: end this hold with nothing (the host calls again).
      if (attempt >= 3) return { exhausted: true as const, body: { steers: [] } };
    }
  };
  const first = await take();
  if ("exhausted" in first) return { body: first.body };
  if (first.status && first.status !== 200) return first;
  const { runId, steers } = first.body as { runId: string; steers: unknown[] };
  if (steers.length > 0 || timeout <= 0) return { body: { steers } };
  while (Date.now() < deadline) {
    await pause(Math.min(HELD_POLL_MS, deadline - Date.now()));
    // The host has gone: stop, so nothing is taken for nobody (and log it, so a deploy can see
    // that request signals abort: wrangler tail).
    if (signal?.aborted) {
      heldAborted("steer", jobId, started);
      return { body: { steers: [] } };
    }
    // Queued and, for an acking host, not on offer (an unacked offer lapses after 60 s).
    const queued = await env.DB.prepare(
      `SELECT 1 FROM core_run_steers WHERE run_id = ? AND delivered_at IS NULL
         ${acking ? "AND (offered_until IS NULL OR offered_until <= ?)" : ""} LIMIT 1`,
    )
      .bind(...(acking ? [runId, new Date().toISOString()] : [runId]))
      .first();
    if (!queued) continue;
    const reply = await take();
    if ("exhausted" in reply) return { body: reply.body };
    // Any refusal (fenced, killed, the run ended) ends the hold: no re-take every 3 s.
    if (reply.status && reply.status !== 200) return reply;
    return { body: { steers: (reply.body as { steers: unknown[] }).steers } };
  }
  return { body: { steers: [] } };
}

/**
 * One line when a held call's request signal aborts (its runner host went away mid-hold), so a
 * deployed engine shows in `wrangler tail` that `enable_request_signal` works (spec 44).
 */
function heldAborted(hold: "steer" | "terminal" | "planning", jobId: string, started: number) {
  console.log(
    `held ${hold} call for ${jobId} aborted by its host after ${Date.now() - started} ms`,
  );
}

/**
 * The runner host's held terminal call (spec 35, ADR 0440; spec 44 part A): `run.terminal.host` as
 * the runner (fenced), then a wait in the Worker. Every HELD_POLL_MS it reads whether the run has an
 * open attach (core_run_terminal_attaches_open_idx). Only then does it ask the job's TerminalRelay,
 * the one that knows who is really connected, for a host ticket (`hostTicket()`, answered at once
 * from its live sockets). D1 only says whether asking is worth it: an attach the relay has no viewer
 * for, older than a viewer ticket lives, was left by a deploy or a crash, and is closed through
 * `run.terminal.closeStale`, so it wakes the relay once, not every poll. The answer is the relay's
 * host socket URL with a one-use ticket, or `connect: null` once the wait's time is up. Never stored.
 */
async function terminalReply(
  env: Env,
  runner: string,
  jobId: string,
  record: Record<string, unknown>,
  origin: string,
  signal?: AbortSignal,
): Promise<ChannelReply> {
  const parsed = terminalCallRequestSchema.safeParse(record);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.message, code: "invalid_input", details: parsed.error.issues },
    };
  }
  const { fencingToken } = parsed.data;
  const actor: Actor = { type: "runner", id: runner };
  const check = await invokeReply(env, "run.terminal.host", { jobId, fencingToken }, actor);
  if (check.status && check.status !== 200) return check;
  const { runId } = check.body as { runId: string };
  const ms = Math.min(parsed.data.waitMs ?? TERMINAL_WAIT_MAX_MS, TERMINAL_WAIT_MAX_MS);
  const deadline = Date.now() + ms;
  for (;;) {
    const open = await env.DB.prepare(
      "SELECT opened_at FROM core_run_terminal_attaches WHERE run_id = ? AND closed_at IS NULL ORDER BY opened_at LIMIT 1",
    )
      .bind(runId)
      .first<{ opened_at: string }>();
    if (open) {
      const { ticket, viewers } = await terminalRelay(env, jobId).hostTicket();
      if (ticket) {
        const url = new URL(TERMINAL_PATHS.host(jobId), origin.replace(/^http/, "ws"));
        url.searchParams.set("ticket", ticket);
        return { body: { connect: { url: url.toString() } } };
      }
      // Twice a ticket's life: an admitted viewer connects well within it.
      const staleBefore = new Date(Date.now() - 2 * TERMINAL_TICKET_TTL_MS).toISOString();
      if (viewers === 0 && open.opened_at < staleBefore) {
        // The relay has no viewer for an attach older than any ticket: left by a deploy or crash.
        const closed = await invokeReply(
          env,
          "run.terminal.closeStale",
          { jobId, fencingToken, before: staleBefore },
          actor,
        );
        if (closed.status && closed.status !== 200) return closed;
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { body: { connect: null } };
    await pause(Math.min(HELD_POLL_MS, left));
    if (signal?.aborted) {
      heldAborted("terminal", jobId, deadline - ms);
      return { body: { connect: null } };
    }
  }
}

/**
 * The runner host's job line (spec 44 part B, ADR 0592): `run.terminal.host` as the runner (fenced:
 * its own live job), then a one-use socket URL for the job's relay. The relay pushes
 * `{ t: "steer" | "viewer" | "planning" }` down it; the host answers each with its own fenced call.
 * Answered at once; never stored.
 */
async function lineReply(
  env: Env,
  runner: string,
  jobId: string,
  record: Record<string, unknown>,
  origin: string,
): Promise<ChannelReply> {
  const parsed = terminalCallRequestSchema.safeParse(record);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: parsed.error.message, code: "invalid_input", details: parsed.error.issues },
    };
  }
  const check = await invokeReply(
    env,
    "run.terminal.host",
    { jobId, fencingToken: parsed.data.fencingToken },
    { type: "runner", id: runner },
  );
  if (check.status && check.status !== 200) return check;
  const ticket = await terminalRelay(env, jobId).lineTicket();
  const url = new URL(TERMINAL_PATHS.line(jobId), origin.replace(/^http/, "ws"));
  url.searchParams.set("ticket", ticket);
  return { body: { connect: { url: url.toString() } } };
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
