// The client door (ADR 0340, ADR 0381, specs 07 and 30): `/client/v1` on sf-engine, next to the
// runner channel; `/cli/v1` is the same door under its first name, which `sf` uses.
// - `device/start` and `device/poll` are the CLI's unsigned device login (as CLI_DEVICE_ACTOR).
// - `desktop/start` and `desktop/exchange` are the desktop app's unsigned sign-in (as
//   DESKTOP_DEVICE_ACTOR).
// - `call` runs one operation as the person behind the bearer token. The token's kind sets the
//   surface (`cli` or `desktop`); nothing in the request does. A `read` CLI token reaches only
//   `read`-risk operations. A desktop call may carry a presence proof, which the door redeems
//   (presence.redeem) before it runs the call with `origin.presence` set to exactly that decision.
// - `batch` runs up to 20 `read`-risk calls in parallel (the desktop app's page loads).
// - Bytes travel as `{ "$bytes": "<base64>" }` in `call` and `batch` (wire-bytes.ts): an attachment
//   upload's input, an attachment's output.
// - `live` (GET, WebSocket) is the desktop app's live connection, held by the person's ClientHub.
// - `ops` lists the operations (the registry's own descriptions), for `sf ops`.
// MCP is meant to come through the same door.
import {
  type Actor,
  CLI_DEVICE_ACTOR,
  DESKTOP_DEVICE_ACTOR,
  describeOperations,
  getOperation,
  inputDigest,
  invoke,
  OperationError,
  type Origin,
  resolveCliToken,
  resolveDesktopToken,
} from "@software-factory/core";
import { createDb } from "@software-factory/db";
import { STATUS } from "./channel.ts";
import { clientHub } from "./client-hub.ts";
import { invokeDeps } from "./deps.ts";
import { decodeBytes, encodeBytes } from "./wire-bytes.ts";

export const CLI_PREFIX = "/cli/v1/";
export const CLIENT_PREFIX = "/client/v1/";
/** The most calls one `batch` may carry. */
export const BATCH_LIMIT = 20;

const NO_STORE = { "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const unauthenticated = () =>
  reply(
    {
      error:
        "not signed in, or the token expired or was revoked: run `sf login` (or sign in to the app again)",
      code: "unauthenticated",
    },
    401,
  );

/** Who a bearer token is: a CLI token (with its scope) or a desktop device's token. */
type Caller =
  | { kind: "cli"; userId: string; scope: "read" | "write" }
  | { kind: "desktop"; userId: string; deviceId: string };

export async function handleCli(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const path = pathname.slice(
    pathname.startsWith(CLIENT_PREFIX) ? CLIENT_PREFIX.length : CLI_PREFIX.length,
  );
  if (path === "ops" && request.method === "GET") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    return reply({ operations: describeOperations() });
  }
  // The desktop app's live connection (spec 40 M2b): the token says who, the person's ClientHub
  // holds the socket. CLI tokens may listen too; MCP will.
  if (path === "live" && request.method === "GET") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return reply({ error: "expected a WebSocket upgrade", code: "invalid_input" }, 426);
    }
    return clientHub(env, who.userId).fetch(request);
  }
  if (request.method !== "POST") return reply({ error: "not found", code: "not_found" }, 404);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ error: "body is not a JSON object", code: "invalid_input" }, 400);
  }

  if (path === "device/start" || path === "device/poll") {
    const op = path === "device/start" ? "cli.deviceStart" : "cli.devicePoll";
    // The device login answers with the output itself (the runner's login does the same).
    return respond(() => run(env, op, body, CLI_DEVICE_ACTOR, { surface: "cli" }), true);
  }
  if (path === "desktop/start" || path === "desktop/exchange") {
    const op = path === "desktop/start" ? "desktop.authStart" : "desktop.authExchange";
    return respond(() => run(env, op, body, DESKTOP_DEVICE_ACTOR, { surface: "desktop" }), true);
  }
  if (path === "call") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.length <= 200
        ? body.idempotencyKey
        : undefined;
    return respond(() =>
      callAs(env, who, body.op, body.input ?? {}, body.presence, idempotencyKey),
    );
  }
  if (path === "batch") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    const calls = body.calls;
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > BATCH_LIMIT) {
      return reply(
        {
          error: `calls must be an array of 1 to ${BATCH_LIMIT} { op, input }`,
          code: "invalid_input",
        },
        400,
      );
    }
    const results = await Promise.all(
      calls.map(async (c: unknown) => {
        const { op, input } = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
        const name = typeof op === "string" ? op : "";
        if (getOperation(name)?.risk !== "read") {
          return {
            ok: false,
            code: "forbidden",
            error: `batch runs read operations only (${name || "none"})`,
          };
        }
        try {
          return {
            ok: true,
            result: encodeBytes((await callAs(env, who, name, input ?? {})).output),
          };
        } catch (error) {
          if (error instanceof OperationError)
            return { ok: false, code: error.code, error: error.message };
          throw error;
        }
      }),
    );
    return reply({ results });
  }
  return reply({ error: "not found", code: "not_found" }, 404);
}

async function authenticate(request: Request, env: Env): Promise<Caller | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token) return null;
  const db = createDb(env.DB);
  const now = new Date().toISOString();
  const desktop = await resolveDesktopToken(db, token, now);
  if (desktop) return { kind: "desktop", userId: desktop.user_id, deviceId: desktop.device_id };
  const cli = await resolveCliToken(db, token, now);
  if (cli) return { kind: "cli", userId: cli.user_id, scope: cli.scope };
  return null;
}

/** One operation as the caller, on the caller's surface, redeeming a presence proof first. */
async function callAs(
  env: Env,
  who: Caller,
  opName: unknown,
  input: unknown,
  presence?: unknown,
  idempotencyKey?: string,
) {
  const name = typeof opName === "string" ? opName : "";
  const op = getOperation(name);
  if (!op) throw new OperationError("unknown_operation", `no operation ${name || "(none)"}`);
  const actor: Actor = { type: "human", id: who.userId };
  if (who.kind === "cli") {
    if (who.scope === "read" && op.risk !== "read") {
      throw new OperationError(
        "forbidden",
        `${name} changes things (risk ${op.risk}); this CLI token is read-only. Run \`sf login --write\` for a token that can.`,
      );
    }
    return run(env, name, decodeBytes(input), actor, { surface: "cli" }, idempotencyKey);
  }
  const origin: Origin = { surface: "desktop", deviceId: who.deviceId };
  if (presence !== undefined) {
    const proof = (presence && typeof presence === "object" ? presence : {}) as Record<
      string,
      unknown
    >;
    const digest = await inputDigest(input);
    // Spend the proof first, so it can't be replayed even if the decision then fails.
    await run(
      env,
      "presence.redeem",
      {
        challengeId: proof.challengeId,
        nonce: proof.nonce,
        signature: proof.signature,
        op: name,
        inputDigest: digest,
      },
      actor,
      origin,
    );
    origin.presence = { op: name, inputDigest: digest, challengeId: String(proof.challengeId) };
  }
  // The proof covers the input as sent; the operation gets its bytes decoded.
  return run(env, name, decodeBytes(input), actor, origin, idempotencyKey);
}

async function run(
  env: Env,
  op: string,
  input: unknown,
  actor: Actor,
  origin: Omit<Origin, "requestId">,
  idempotencyKey?: string,
) {
  const result = await invoke(invokeDeps(env), op, input, {
    actor,
    origin: { ...origin, requestId: crypto.randomUUID() },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  return result.status === "pending"
    ? { pending: true as const, pendingActionId: result.pendingActionId }
    : { pending: false as const, output: result.output };
}

async function respond(
  call: () => Promise<
    { pending: true; pendingActionId: string } | { pending: false; output: unknown }
  >,
  bare = false,
): Promise<Response> {
  try {
    const r = await call();
    if (r.pending) return reply({ pending: true, pendingActionId: r.pendingActionId }, 202);
    return reply(bare ? r.output : { result: encodeBytes(r.output) });
  } catch (error) {
    if (error instanceof OperationError) {
      return reply(
        {
          error: error.message,
          code: error.code,
          ...(error.code === "invalid_input" ||
          (error.code === "forbidden" && error.details !== undefined)
            ? { details: error.details }
            : {}),
        },
        STATUS[error.code],
      );
    }
    throw error;
  }
}
