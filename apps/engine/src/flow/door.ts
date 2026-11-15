// The new core's operations through the client door (/client/v1, /cli/v1; spec 70): a `flow.` call
// runs in @software-factory/ops as the person behind the bearer token, answered in the door's own
// envelope ({ result } or { error, code, details? }) so the desktop app and `sf call` need no change.
import {
  type Caller,
  type CallResult,
  call,
  describe,
  getOperation,
  PREFIX,
} from "@software-factory/ops";
import type { PluginHostEnv } from "@software-factory/plugins";
import { STATUS } from "../channel.ts";
import { secrets } from "../secrets.ts";

export const isFlowOp = (op: unknown): op is string =>
  typeof op === "string" && op.startsWith(PREFIX);

export const getFlowOperation = getOperation;

/** What the plugin host gets from the engine: D1, the Worker Loader, and the gateway key. */
export function flowHost(env: Env): PluginHostEnv {
  const key = secrets(env).FLOW_GATEWAY_KEY;
  return { DB: env.DB, LOADER: env.LOADER, ...(key ? { FLOW_GATEWAY_KEY: key } : {}) };
}

/** The flow operations as the door's `ops` lists the old core's (registry.describeOperations). */
export function describeFlowOperations() {
  return describe().map((op) => ({
    ...op,
    actors: ["human"],
    permission: "org member",
    fenced: false,
    gateKind: null,
    browserOnly: false,
  }));
}

/** One flow operation as `actor`: a person through the door, or an agent through the MCP server. */
export function callFlowAs(
  env: Env,
  actor: Caller,
  op: string,
  input: unknown,
): Promise<CallResult> {
  return call(op, input, { d1: env.DB, host: flowHost(env), actor });
}

/**
 * One flow operation as the door's caller. A read-only CLI token reaches only `read` operations,
 * as it does the old core's.
 */
export function callFlow(
  env: Env,
  who: { kind: string; userId: string; scope?: "read" | "write" },
  op: string,
  input: unknown,
): Promise<CallResult> {
  if (who.kind === "cli" && who.scope === "read" && getOperation(op)?.risk === "write") {
    return Promise.resolve({
      ok: false,
      error: {
        code: "forbidden",
        message: `${op} changes things; this CLI token is read-only. Run \`sf login --write\` for a token that can.`,
      },
    });
  }
  return callFlowAs(env, { kind: "person", id: who.userId }, op, input);
}

/** A refusal in the door's envelope; `internal` (logged by ops, never detailed) is a 500. */
export function flowRefusal(error: Extract<CallResult, { ok: false }>["error"]): Response {
  const status = error.code === "internal" ? 500 : STATUS[error.code];
  return Response.json(
    {
      error: error.message,
      code: error.code,
      ...(error.code === "invalid_input" && error.details !== undefined
        ? { details: error.details }
        : {}),
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}
