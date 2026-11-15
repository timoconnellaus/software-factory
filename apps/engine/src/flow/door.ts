// The new core's operations through the client door (/client/v1, /cli/v1; spec 70): a `flow.` call
// runs in @software-factory/ops as the person behind the bearer token, answered in the door's own
// envelope ({ result } or { error, code, details? }) so the desktop app and `sf call` need no change.
import { type CallResult, call, describe, getOperation, PREFIX } from "@software-factory/ops";
import { STATUS } from "../channel.ts";

export const isFlowOp = (op: unknown): op is string =>
  typeof op === "string" && op.startsWith(PREFIX);

export const getFlowOperation = getOperation;

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
  return call(op, input, { d1: env.DB, actor: { kind: "person", id: who.userId } });
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
