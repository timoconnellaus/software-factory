// The sf CLI's door (ADR 0340, spec 07): `/cli/v1` on sf-engine, next to the runner channel.
// - `device/start` and `device/poll` are the unsigned device login (as CLI_DEVICE_ACTOR).
// - `call` runs one operation as the person behind the bearer token, on the `cli` surface: the
//   token sets the actor, nothing in the request does. A `read` token reaches only `read`-risk
//   operations. Browser-only decisions are refused by `invoke()` itself, whatever the scope.
// - `ops` lists the operations (the registry's own descriptions), for `sf ops`.
// MCP is meant to come through the same door.
import {
  type Actor,
  CLI_DEVICE_ACTOR,
  describeOperations,
  getOperation,
  invoke,
  OperationError,
  resolveCliToken,
} from "@software-factory/core";
import { createDb } from "@software-factory/db";
import { STATUS } from "./channel.ts";
import { invokeDeps } from "./deps.ts";

export const CLI_PREFIX = "/cli/v1/";

const NO_STORE = { "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const unauthenticated = () =>
  reply(
    {
      error: "not signed in, or the token expired or was revoked: run `sf login`",
      code: "unauthenticated",
    },
    401,
  );

export async function handleCli(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname.slice(CLI_PREFIX.length);
  if (path === "ops" && request.method === "GET") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    return reply({ operations: describeOperations() });
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
    return run(env, op, body, CLI_DEVICE_ACTOR, undefined, true);
  }
  if (path === "call") {
    const who = await authenticate(request, env);
    if (!who) return unauthenticated();
    const name = typeof body.op === "string" ? body.op : "";
    const op = getOperation(name);
    if (!op)
      return reply({ error: `no operation ${name || "(none)"}`, code: "unknown_operation" }, 404);
    if (who.scope === "read" && op.risk !== "read") {
      return reply(
        {
          error: `${name} changes things (risk ${op.risk}); this CLI token is read-only. Run \`sf login --write\` for a token that can.`,
          code: "forbidden",
        },
        403,
      );
    }
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey.length <= 200
        ? body.idempotencyKey
        : undefined;
    return run(env, name, body.input ?? {}, { type: "human", id: who.user_id }, idempotencyKey);
  }
  return reply({ error: "not found", code: "not_found" }, 404);
}

async function authenticate(request: Request, env: Env) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) return null;
  return resolveCliToken(createDb(env.DB), match[1], new Date().toISOString());
}

async function run(
  env: Env,
  op: string,
  input: unknown,
  actor: Actor,
  idempotencyKey?: string,
  bare = false,
): Promise<Response> {
  try {
    const result = await invoke(invokeDeps(env), op, input, {
      actor,
      origin: { surface: "cli", requestId: crypto.randomUUID() },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (result.status === "pending") {
      return reply({ pending: true, pendingActionId: result.pendingActionId }, 202);
    }
    return reply(bare ? result.output : { result: result.output });
  } catch (error) {
    if (error instanceof OperationError) {
      return reply(
        {
          error: error.message,
          code: error.code,
          ...(error.code === "invalid_input" ? { details: error.details } : {}),
        },
        STATUS[error.code],
      );
    }
    throw error;
  }
}
