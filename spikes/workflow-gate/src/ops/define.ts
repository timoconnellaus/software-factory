// The operations registry: every factory verb is defined once, with zod schemas, a description and
// a risk class. The inbox, the Workflow and (later) the MCP surface and runner RPC all call
// operations through `invoke()`, never the tables directly.
import type { z } from "zod";
import type { ActorType, RiskClass } from "./gate";

export interface Actor {
  type: ActorType;
  /** Who: a user id, an agent role, a runner id, an intake source. */
  id: string;
}

export interface Origin {
  surface: "inbox" | "api" | "workflow" | "cron" | "test";
  workflowId?: string;
  step?: string;
}

export type OutboxMessage =
  | { kind: "workflow.create"; payload: { id: string; params: { workItemId: string } } }
  | {
      kind: "workflow.event";
      payload: { instanceId: string; type: string; payload: Record<string, string> };
    }
  | { kind: "workflow.pause"; payload: { instanceId: string } }
  | { kind: "workflow.resume"; payload: { instanceId: string; killEpoch: number } }
  /** Stand-in for push notifications (the phone app plugs in here later). */
  | { kind: "notify"; payload: { event: string; [key: string]: string } };

export interface PendingActionRow {
  id: string;
  operation: string;
  risk: string;
  actor_type: string;
  actor_id: string;
  input: string;
  work_item_id: string | null;
  workflow_id: string | null;
  status: "pending" | "approved" | "rejected" | "applied";
}

export interface HandlerContext {
  env: Env;
  db: D1Database;
  actor: Actor;
  origin: Origin;
  /** ISO time of this invocation; use it instead of reading the clock. */
  now: string;
  /** Queue a write. Writes commit in one D1 batch with the audit and outbox rows. */
  write(statement: D1PreparedStatement): void;
  /** Queue an outbox message, committed in the same batch and delivered after commit. */
  emit(message: OutboxMessage): void;
  /** The work item this call is about, for the audit row (when the input does not name one). */
  subject(workItemId: string): void;
  /** Set when this call is the approved re-run of a pending action. */
  approval?: PendingActionRow;
}

export interface Operation<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  risk: RiskClass;
  input: I;
  output: O;
  /** Restricts which actor types may call it at all (checked before the gate). */
  actors?: readonly ActorType[];
  handler(input: z.output<I>, ctx: HandlerContext): Promise<z.input<O>>;
}

const registry = new Map<string, Operation>();

export function defineOperation<I extends z.ZodType, O extends z.ZodType>(
  op: Operation<I, O>,
): Operation<I, O> {
  if (registry.has(op.name)) throw new Error(`operation ${op.name} is already defined`);
  registry.set(op.name, op as unknown as Operation);
  return op;
}

export function getOperation(name: string): Operation | undefined {
  return registry.get(name);
}

/** What `describe_operations` would return on the MCP surface. */
export function describeOperations() {
  return [...registry.values()].map(({ name, description, risk, actors }) => ({
    name,
    description,
    risk,
    actors: actors ?? "any",
  }));
}
