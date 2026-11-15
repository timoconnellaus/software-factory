// The registry and `call`: look the operation up, validate its input, check the caller may act in
// the org it names, run it, and answer { ok, result } or { ok: false, error }.
import { FlowError } from "@software-factory/flow";
import { NoLoaderError, type PluginHostEnv, PluginRefusal } from "@software-factory/plugins";
import { StoreError } from "@software-factory/store";
import { z } from "zod";
import { itemOps } from "./items.ts";
import { type Caller, type ErrorCode, OpError, type Operation } from "./operation.ts";
import { gatewayOps, pluginOps } from "./plugins.ts";
import { agentOps, projectOps } from "./projects.ts";
import { readOps } from "./reads.ts";
import { checkScope } from "./scope.ts";
import { workflowOps } from "./workflows.ts";

const OPERATIONS: readonly Operation[] = [
  ...workflowOps,
  ...projectOps,
  ...agentOps,
  ...itemOps,
  ...readOps,
  ...pluginOps,
  ...gatewayOps,
];

const BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));

/** Every operation's name starts with this, so none can collide with the old core's. */
export const PREFIX = "flow.";

export function getOperation(name: string): Operation | undefined {
  return BY_NAME.get(name);
}

/** Names, descriptions and risk, for a client's list of operations. */
export function describe(): { name: string; description: string; risk: "read" | "write" }[] {
  return OPERATIONS.map(({ name, description, risk }) => ({ name, description, risk }));
}

/** Names, descriptions, risk and each input's JSON Schema: what an agent reads to call them. */
export function describeWithInputs() {
  return OPERATIONS.map(({ name, description, risk, input }) => ({
    name,
    description,
    risk,
    input: z.toJSONSchema(input, { io: "input", unrepresentable: "any" }),
  }));
}

export interface CallContext {
  d1: D1Database;
  actor: Caller;
  /** The plugin host's bindings; default D1 alone (plugins with hooks then fail when they run). */
  host?: PluginHostEnv;
  /** Milliseconds since the epoch; defaults to now. */
  now?: number;
}

export type CallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };

const FLOW_CODES: Record<FlowError["code"], ErrorCode> = {
  unknown_status: "invalid_input",
  not_waiting: "conflict",
  needs_decision: "conflict",
  not_a_person: "forbidden",
  no_error: "conflict",
};

const STORE_CODES: Record<StoreError["code"], ErrorCode> = {
  not_found: "not_found",
  conflict: "conflict",
  stale_run: "conflict",
  invalid: "invalid_input",
  unavailable: "unavailable",
};

export async function call(name: string, rawInput: unknown, ctx: CallContext): Promise<CallResult> {
  const op = BY_NAME.get(name);
  if (!op) {
    return { ok: false, error: { code: "unknown_operation", message: `No operation ${name}.` } };
  }
  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        details: parsed.error.issues,
      },
    };
  }
  const input = parsed.data;
  try {
    await checkScope(ctx.d1, input.orgId, ctx.actor, input as Record<string, unknown>);
    const result = await op.handler(input, {
      d1: ctx.d1,
      host: ctx.host ?? { DB: ctx.d1 },
      orgId: input.orgId,
      actor: ctx.actor,
      now: ctx.now ?? Date.now(),
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof OpError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };
    }
    if (error instanceof PluginRefusal) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: error.message,
          details: { refusedBy: error.plugin, reason: error.reason },
        },
      };
    }
    if (error instanceof FlowError) {
      return { ok: false, error: { code: FLOW_CODES[error.code], message: error.message } };
    }
    if (error instanceof StoreError) {
      return { ok: false, error: { code: STORE_CODES[error.code], message: error.message } };
    }
    if (error instanceof NoLoaderError) {
      return { ok: false, error: { code: "unavailable", message: error.message } };
    }
    console.error(`${name} failed`, error);
    return { ok: false, error: { code: "internal", message: `${name} failed. Try again.` } };
  }
}
