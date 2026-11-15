// The shape of an operation: a name, what it does in words a model can read, a zod input, and a
// handler. Nothing else: no roles, approvals or audit (spec 70: keep it simple).
import type { Actor } from "@software-factory/flow";
import type { PluginHostEnv } from "@software-factory/plugins";
import { z } from "zod";

export type Person = { kind: "person"; id: string };

/**
 * An agent calling through the engine's MCP server, during one of its runs: it acts in the run's
 * org (and only there), for the person who created the run's item.
 */
export type AgentCaller = { kind: "agent"; id: string; orgId: string; onBehalfOf: string };

export type Caller = Person | AgentCaller;

/** The caller as the kernel and the timeline record it. */
export const kernelActor = (caller: Caller): Actor => ({ kind: caller.kind, id: caller.id });

/** The person a caller acts as: who an item they create belongs to. */
export const personOf = (caller: Caller): string =>
  caller.kind === "person" ? caller.id : caller.onBehalfOf;

/** What a handler gets: the org the call is in (checked: the actor is a member), who, and when. */
export interface Ctx {
  d1: D1Database;
  /** The engine's bindings the plugin host needs (D1, the Worker Loader, the gateway key). */
  host: PluginHostEnv;
  orgId: string;
  actor: Caller;
  /** Milliseconds since the epoch. */
  now: number;
}

export type ErrorCode =
  | "unknown_operation"
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "internal";

/** A refusal a handler (or `call`) raises on purpose. Its message is shown to the caller. */
export class OpError extends Error {
  constructor(
    readonly code: Exclude<ErrorCode, "internal">,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpError";
  }
}

export interface Operation<I extends { orgId: string } = { orgId: string }, O = unknown> {
  name: string;
  description: string;
  /** `read` changes nothing; a read-only CLI token may call only these. */
  risk: "read" | "write";
  input: z.ZodType<I>;
  handler(input: I, ctx: Ctx): Promise<O>;
}

/** Keeps the handler's input typed by its schema. */
export function defineOperation<S extends z.ZodType<{ orgId: string }>, O>(op: {
  name: string;
  description: string;
  risk: "read" | "write";
  input: S;
  handler(input: z.infer<S>, ctx: Ctx): Promise<O>;
}): Operation {
  return op as unknown as Operation;
}

/** Every operation's input starts with the org it acts in. */
export const orgId = z.string().min(1);
export const id = z.string().min(1).max(100);
