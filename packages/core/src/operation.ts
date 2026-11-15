// defineOperation (ADR 0003): every platform verb is defined once with zod schemas, a description, a
// permission, a risk class and the actors allowed to call it. The website (through the engine's
// RPC), the client door and the runner channel call operations through `invoke()`; nothing else
// writes these tables.
import type { Db } from "@software-factory/db";
import type { Compilable } from "kysely";
import type { z } from "zod";
import type { Actor, ActorType, DeviceSurface, Origin } from "./actors.ts";
import type { FactoryServices } from "./services.ts";

/**
 * Who among humans may call it (non-human actors are governed by `actors`):
 * - `signed-in`: any signed-in user (the handler checks ownership where it matters);
 * - `member`: a member of the org the input names (`orgId`);
 * - `admin`: an owner or admin of that org.
 */
export const PERMISSIONS = ["signed-in", "member", "admin"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** A read changes nothing; a write may. */
export const RISK_CLASSES = ["read", "write"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Messages written to the outbox in the operation's batch and delivered after commit by sf-engine. */
export type OutboxMessage =
  /** A device was revoked (ADR 0541): sf-engine closes its live socket in the person's ClientHub. */
  | { kind: "device.revoked"; payload: { userId: string; deviceId: string } }
  /** A notification for a person's desktop apps, through their ClientHub. */
  | {
      kind: "notify";
      payload: { event: string; userId?: string | null; title: string; url?: string };
    };

export type OutboxKind = OutboxMessage["kind"];

/** What a call is about, resolved by `invoke()`: the org its input names, if any. */
export interface Scope {
  orgId: string | null;
}

/** What a call names in its input, from which `invoke()` resolves the scope. */
export interface ScopeRef {
  orgId?: string | null;
}

/** One record touched, for the audit row's diff (spec 01, criterion 6). */
export interface Change {
  entity: string;
  id: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface HandlerContext {
  /** Typed reads. Writes go through `write()`: they commit in one batch after the handler. */
  db: Db;
  d1: D1Database;
  actor: Actor;
  origin: Origin;
  /** ISO time of this invocation; use it instead of reading the clock. */
  now: string;
  services: FactoryServices;
  scope: Scope;
  /** The device sent a valid presence proof for exactly this call (ADR 0391, 0541). */
  presence?: boolean;
  /** Queue a write. Writes, guards, the audit row and outbox rows commit in one D1 batch. */
  write(statement: Compilable | D1PreparedStatement): void;
  /** Abort the whole batch unless the previous write changed at least one row (ADR 0050). */
  guardChanged(name: string): void;
  /** Abort the whole batch unless `query` returns a row when the batch runs. */
  guardExists(name: string, query: Compilable): void;
  /** Queue an outbox message, committed in the same batch and delivered after commit. */
  emit(message: OutboxMessage): void;
  /** Record a change for the audit row's diff. */
  change(change: Change): void;
  /**
   * Mark this call as one that changed something a person may want to read later, without a diff:
   * a changes-only operation (`audit.changesOnly`) then writes its audit row (ADR 0590).
   */
  changed(): void;
  /** Point the audit row at an org the input didn't name. */
  subject(ref: { orgId?: string }): void;
}

export interface Operation<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  /** Model-facing copy: what it does, when to use it, what it refuses. */
  description: string;
  risk: RiskClass;
  input: I;
  output: O;
  /** Actor types that may call it at all. */
  actors: readonly ActorType[];
  /** What a human needs (see `Permission`). */
  permission: Permission;
  /**
   * A decision only a person makes in the browser (ADR 0340): device approvals, runner
   * registration. `invoke()` refuses it for a human on any surface but `app`, so a CLI token an
   * agent might hold can never approve anything.
   */
  browserOnly?: true;
  /**
   * The device surfaces whose presence proof the operation takes (ADR 0391, 0541): adding a phone
   * from the desktop (`mobile.pairOffer`), renewing a phone's token (`mobile.renew`), turning a
   * device's approvals back on (`device.update`). None by default.
   */
  presenceSurfaces?: readonly DeviceSurface[];
  /** How to find the scope when the default (the input's `orgId`) isn't enough. */
  scope?: (input: z.output<I>, db: Db) => Promise<ScopeRef>;
  /**
   * Machine-frequency operations (a heartbeat, an empty claim; ADR 0590, AGENTS.md "Cloudflare
   * cost" rule 12) write no audit row unless the call changed state: the handler called
   * `ctx.change` or `ctx.changed`, queued an outbox message, or `changed(output)` is true.
   * Refusals and failures are always audited, and so is a call with an idempotency key.
   */
  audit?: { changesOnly: true; changed?: (output: z.output<O>) => boolean };
  /** Strip secrets before the input/output is written to the audit journal. */
  redact?: { input?: (input: z.output<I>) => unknown; output?: (output: z.output<O>) => unknown };
  handler(input: z.output<I>, ctx: HandlerContext): Promise<z.input<O>>;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds operations of every input/output type.
export type AnyOperation = Operation<any, any>;

export function defineOperation<I extends z.ZodType, O extends z.ZodType>(
  op: Operation<I, O>,
): Operation<I, O> {
  return op;
}
