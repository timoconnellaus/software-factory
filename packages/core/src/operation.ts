// defineOperation (ADR 0003): every factory verb is defined once with zod schemas, a model-facing
// description, a permission, a risk class and the actors allowed to call it. The app (through the
// engine's RPC), MCP and the runner channel all call operations through `invoke()`; nothing else
// writes to D1.
import type {
  CoreOrganizationTable,
  CorePendingActionsTable,
  CoreProjectsTable,
  CoreWorkItemsTable,
  Db,
} from "@software-factory/db";
import type { Compilable, Selectable } from "kysely";
import type { z } from "zod";
import type { Actor, ActorType, Origin } from "./actors.ts";
import type { RiskClass } from "./policy/gate.ts";
import type { ProjectPolicy } from "./policy/project-policy.ts";
import type { FactoryServices } from "./services.ts";

/**
 * Who among humans may call it (checked after the gate; non-human actors are governed by the gate
 * and `actors`):
 * - `signed-in`: any signed-in user (the handler checks ownership where it matters);
 * - `member`: a member of the work item's / project's org;
 * - `approver`: an approver of the project (`.factory/` approvers, else org owners and admins);
 * - `admin`: an owner or admin of the org.
 */
export const PERMISSIONS = ["signed-in", "member", "approver", "admin"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Messages written to the outbox in the operation's batch and delivered after commit by sf-engine. */
export type OutboxMessage =
  | { kind: "workflow.create"; payload: { instanceId: string; params: { workItemId: string } } }
  | {
      kind: "workflow.event";
      payload: { instanceId: string; type: string; payload: Record<string, unknown> };
    }
  | { kind: "workflow.pause"; payload: { instanceId: string } }
  /** Resume, then send each event type (releases steps parked by a kill switch). */
  | { kind: "workflow.resume"; payload: { instanceId: string; events: string[] } }
  | { kind: "workflow.terminate"; payload: { instanceId: string } }
  /** A notification for a person (web push in spec 15). `url` is the deep link. */
  | {
      kind: "notify";
      payload: {
        event: string;
        userId?: string | null;
        workItemId?: string | null;
        title: string;
        url?: string;
      };
    };

export type OutboxKind = OutboxMessage["kind"];

export type WorkItemRow = Selectable<CoreWorkItemsTable>;
export type ProjectRow = Selectable<CoreProjectsTable>;
export type OrgRow = Selectable<CoreOrganizationTable>;
export type PendingActionRow = Selectable<CorePendingActionsTable>;

/** What a call is about, resolved by `invoke()` before the gate. */
export interface Scope {
  orgId: string | null;
  projectId: string | null;
  workItemId: string | null;
  workItem: WorkItemRow | null;
  project: ProjectRow | null;
  /** The project's policy at `policySha`; null when missing or malformed (fails closed). */
  policy: ProjectPolicy | null;
  policySha: string | null;
  policyError: string | null;
}

/** What a call names in its input, from which `invoke()` resolves the scope. */
export interface ScopeRef {
  workItemId?: string | null;
  projectId?: string | null;
  orgId?: string | null;
  jobId?: string | null;
  questionId?: string | null;
  pendingActionId?: string | null;
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
  /** Set when this call is the approved re-run of a pending action. */
  approval?: PendingActionRow;
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
  /** Point the audit row at a work item / project the input didn't name (e.g. a created one). */
  subject(ref: { workItemId?: string; projectId?: string; orgId?: string }): void;
}

export interface Operation<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  /** Model-facing copy: what it does, when to use it, what it refuses. */
  description: string;
  /** The declared risk class (and the default for `riskOf`). */
  risk: RiskClass;
  /** A risk that depends on the input, e.g. a merge whose diff touches `.factory/` is self-modify. */
  riskOf?: (input: z.output<I>) => RiskClass;
  input: I;
  output: O;
  /** Actor types that may call it at all (checked before the gate). */
  actors: readonly ActorType[];
  /** What a human needs (see `Permission`). */
  permission: Permission;
  /** Writes from a lease holder: the input's `fencingToken` must be the work item's current one. */
  fenced?: boolean;
  /** Still runs for non-humans while a kill switch covers the item (e.g. a runner releasing). */
  allowWhenKilled?: boolean;
  /**
   * The call is how a project's policy arrives (the connector mirroring `.factory/policy.json` from a
   * default-branch push), so it can't wait for one: the gate judges it as for an unscoped call
   * (Cautious + the floor) instead of failing closed on a missing or malformed policy. Only for
   * operations that apply nothing but default-branch content.
   */
  bootstrapsPolicy?: boolean;
  /** Which inbox card a `review` answer becomes. Default `approval`. */
  gateKind?: "spec" | "merge" | "approval";
  /**
   * Hide what the caller may not see (ADR 0260): when set, a scope that can't be resolved and a human
   * without the permission both get `not_found` with this message, so a missing record and one in
   * an org the caller can't reach look the same.
   */
  concealAs?: (input: z.output<I>) => string;
  /** How to find the scope when the default (input field names) isn't enough. */
  scope?: (input: z.output<I>, db: Db) => Promise<ScopeRef>;
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
