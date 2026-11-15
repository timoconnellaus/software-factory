// The shape of an operation: a name, what it does in words a model can read, a zod input, and a
// handler. Nothing else: no roles, approvals or audit (spec 70: keep it simple).
import { z } from "zod";

export type Person = { kind: "person"; id: string };

/** What a handler gets: the org the call is in (checked: the actor is a member), who, and when. */
export interface Ctx {
  d1: D1Database;
  orgId: string;
  actor: Person;
  /** Milliseconds since the epoch. */
  now: number;
}

export type ErrorCode =
  | "unknown_operation"
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "conflict"
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
