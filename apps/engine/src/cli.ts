// The client door (ADR 0340, ADR 0391, specs 07 and 30): `/client/v1` on sf-engine, next to the
// runner channel; `/cli/v1` is the same door under its first name, which `sf` uses.
// - `device/start` and `device/poll` are the CLI's unsigned device login (as CLI_DEVICE_ACTOR).
// - `desktop/start` and `desktop/exchange` are the desktop app's unsigned sign-in (as
//   DESKTOP_DEVICE_ACTOR).
// - `call` runs one operation as the person behind the bearer token: a platform operation
//   (packages/core) or the new core's `flow.*` (packages/ops). The token's kind sets the surface
//   (`cli` or `desktop`); nothing in the request does. A `read` CLI token reaches only `read`-risk
//   operations. A desktop call may carry a presence proof, which the door redeems (presence.redeem)
//   before it runs the call with `origin.presence` set to exactly that call.
// - `batch` runs up to 20 `read`-risk calls in parallel (the desktop app's page loads).
// - `mobile/nonce`, `mobile/start` and `mobile/exchange` are the phone app's unsigned sign-in (as
//   MOBILE_DEVICE_ACTOR, ADR 0541); a `mobile` token's calls run on the `mobile` surface, and a
//   phone below MOBILE_MIN_PROTOCOL gets 426 (mobile.ts).
// - `live` (GET, WebSocket) is the desktop app's live connection, held by the person's ClientHub.
// - `ops` lists the operations (the registry's own descriptions), for `sf ops`.
// - The version handshake (spec 40 M4, ADR 0393): the desktop app sends `x-sf-client-protocol`. A
//   desktop sign-in or a desktop token's request below DESKTOP_MIN_PROTOCOL gets 426
//   `update_required`, and the app updates. No header is protocol 0 (builds before the handshake).
//   It is checked once, in `versionGate` at the top of `handleCli`, so every route and socket a
//   desktop token can reach gets it, including routes added later. A client opening a WebSocket
//   must send the protocol headers on the upgrade request too.
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
  resolveMobileToken,
} from "@software-factory/core";
import { createDb } from "@software-factory/db";
import { STATUS } from "./channel.ts";
import { clientHub, DEVICE_HEADER } from "./client-hub.ts";
import { invokeDeps } from "./deps.ts";
import {
  callFlow,
  describeFlowOperations,
  flowRefusal,
  getFlowOperation,
  isFlowOp,
} from "./flow/door.ts";
import {
  MOBILE_DEVICE_ACTOR,
  mobileCaller,
  mobileNonceLimit,
  mobileSignInConflict,
  mobileSignInRoute,
  mobileTooOld,
  mobileUpdateRequired,
} from "./mobile.ts";

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

/** The header the desktop app names its door protocol in (ADR 0393). */
export const CLIENT_PROTOCOL_HEADER = "x-sf-client-protocol";

/**
 * The newest desktop door protocol this engine knows (apps/desktop's DOOR_PROTOCOL; bump them
 * together). A DESKTOP_MIN_PROTOCOL above it is a mistake that would refuse every build, sign-in
 * included, so it is ignored (and logged) instead of enforced.
 */
export const DESKTOP_PROTOCOL_LATEST = 2;

/** The floor to enforce, or null (unset, 0, malformed or above DESKTOP_PROTOCOL_LATEST). */
export function desktopMinProtocol(env: Pick<Env, "DESKTOP_MIN_PROTOCOL">): number | null {
  const raw = env.DESKTOP_MIN_PROTOCOL ?? "";
  if (!/^\d{1,6}$/.test(raw) || Number(raw) <= 0) return null;
  const min = Number(raw);
  if (min > DESKTOP_PROTOCOL_LATEST) {
    console.error(
      `DESKTOP_MIN_PROTOCOL=${min} is above the newest desktop protocol (${DESKTOP_PROTOCOL_LATEST}); not enforced`,
    );
    return null;
  }
  return min;
}

/** The desktop build speaks a door protocol older than the engine still serves (ADR 0393). */
export function desktopTooOld(request: Request, env: Pick<Env, "DESKTOP_MIN_PROTOCOL">): boolean {
  const min = desktopMinProtocol(env);
  if (min === null) return false;
  const sent = request.headers.get(CLIENT_PROTOCOL_HEADER) ?? "";
  const protocol = /^\d{1,6}$/.test(sent) ? Number(sent) : 0;
  return protocol < min;
}

const updateRequired = (env: Pick<Env, "DESKTOP_MIN_PROTOCOL">) =>
  reply(
    {
      error:
        "This version of the Software Factory app is too old for the factory. Update it: menu bar, Restart to update (or download it again).",
      code: "update_required",
      minProtocol: desktopMinProtocol(env),
    },
    426,
  );

/**
 * The version handshake for every door route and socket, in one place (ADR 0393): a desktop
 * sign-in, or any request with a desktop token, below the floor gets 426 `update_required`. CLI
 * tokens and unauthenticated requests pass through to the route, which answers as usual. Costs
 * nothing while no floor is set; with one, the token lookup is shared with the route's own.
 */
async function versionGate(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!desktopTooOld(request, env)) return null;
  const desktop =
    path.startsWith("desktop/") || (await authenticate(request, env))?.kind === "desktop";
  return desktop ? updateRequired(env) : null;
}

/** Who a bearer token is: a CLI token (with its scope), or a desktop's or a phone's device token. */
type Caller =
  | { kind: "cli"; userId: string; scope: "read" | "write" }
  | { kind: "desktop" | "mobile"; userId: string; deviceId: string; tokenId: string };

export async function handleCli(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const path = pathname.slice(
    pathname.startsWith(CLIENT_PREFIX) ? CLIENT_PREFIX.length : CLI_PREFIX.length,
  );
  if (mobileTooOld(request, path)) return mobileUpdateRequired();
  const tooOld = await versionGate(request, env, path);
  if (tooOld) return tooOld;
  if (path === "ops" && request.method === "GET") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    return reply({ operations: [...describeOperations(), ...describeFlowOperations()] });
  }
  // The desktop app's live connection (spec 40 M2b): the token says who, the person's ClientHub
  // holds the socket. CLI tokens may listen too; MCP will.
  if (path === "live" && request.method === "GET") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return reply({ error: "expected a WebSocket upgrade", code: "invalid_input" }, 426);
    }
    // The hub tags a device's socket with its id, so revoking the device closes it (ADR 0541).
    const headers = new Headers(request.headers);
    headers.delete(DEVICE_HEADER);
    if (who.kind !== "cli") headers.set(DEVICE_HEADER, who.deviceId);
    return clientHub(env, who.userId).fetch(new Request(request, { headers }));
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
  const phoneSignIn = mobileSignInRoute(path);
  if (phoneSignIn) {
    return respond(async () => {
      const caller = await mobileCaller(request, env);
      // The nonce's courtesy limit, at the edge: an over-limit caller never reaches D1.
      if (phoneSignIn === "mobile.nonce") await mobileNonceLimit(env, caller);
      let r: Awaited<ReturnType<typeof run>>;
      try {
        r = await run(env, phoneSignIn, body, MOBILE_DEVICE_ACTOR, { surface: "mobile", caller });
      } catch (error) {
        throw mobileSignInConflict(phoneSignIn, error);
      }
      // A refusal after the nonce was found commits (the nonce spent, a typed code counted), then
      // is answered as an error.
      const out = r.output as { status?: string; code?: string; error?: string };
      if (out?.status === "refused") {
        const code = out.code === "denied" || out.code === "unavailable" ? out.code : "forbidden";
        throw new OperationError(code, out.error ?? "refused", out);
      }
      return r;
    }, true);
  }
  if (path === "call") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    // The new core's operations (spec 70) go to @software-factory/ops, in the same envelope.
    if (isFlowOp(body.op)) {
      const out = await callFlow(env, who, body.op, body.input ?? {});
      return out.ok ? reply({ result: out.result }) : flowRefusal(out.error);
    }
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
        if (isFlowOp(name)) {
          if (getFlowOperation(name)?.risk !== "read") {
            return {
              ok: false,
              code: "forbidden",
              error: `batch runs read operations only (${name})`,
            };
          }
          const out = await callFlow(env, who, name, input ?? {});
          return out.ok
            ? { ok: true, result: out.result }
            : { ok: false, code: out.error.code, error: out.error.message };
        }
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
            result: (await callAs(env, who, name, input ?? {})).output,
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

/** One token lookup per request: the version gate and the route share it. */
const callers = new WeakMap<Request, Promise<Caller | null>>();

function authenticate(request: Request, env: Env): Promise<Caller | null> {
  let caller = callers.get(request);
  if (!caller) {
    caller = lookUpCaller(request, env);
    callers.set(request, caller);
  }
  return caller;
}

async function lookUpCaller(request: Request, env: Env): Promise<Caller | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token) return null;
  const db = createDb(env.DB);
  const now = new Date().toISOString();
  const desktop = await resolveDesktopToken(db, token, now);
  if (desktop) {
    return {
      kind: "desktop",
      userId: desktop.user_id,
      deviceId: desktop.device_id,
      tokenId: desktop.id,
    };
  }
  const phone = await resolveMobileToken(db, token, now);
  if (phone) {
    return { kind: "mobile", userId: phone.user_id, deviceId: phone.device_id, tokenId: phone.id };
  }
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
    return run(env, name, input, actor, { surface: "cli" }, idempotencyKey);
  }
  // The token's kind sets the surface; nothing in the request does (ADR 0391, 0541).
  const origin: Origin = { surface: who.kind, deviceId: who.deviceId };
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
  return run(env, name, input, actor, origin, idempotencyKey);
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
  return { output: result.output };
}

async function respond(call: () => Promise<{ output: unknown }>, bare = false): Promise<Response> {
  try {
    const r = await call();
    return reply(bare ? r.output : { result: r.output });
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
