import { z } from "zod";

/** Who a status hands an item to when the item enters it. */
export const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }),
  z.object({ kind: z.literal("person"), userId: z.string().min(1) }),
  z.object({ kind: z.literal("none") }),
]);
export type Owner = z.infer<typeof ownerSchema>;

/** One column on the board. */
export const statusSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  owner: ownerSchema,
  /** What an agent owner is asked to do here. */
  brief: z.string().max(8_000).default(""),
  /** Where the item goes when the work here is done. Default: the next status in the list. */
  onDone: z.string().optional(),
  /** Where the item goes when the work here is rejected. Default: the status before this one. */
  onReject: z.string().optional(),
  /** Leaving this status takes a person's decision. */
  needsDecision: z.boolean().default(false),
});
export type Status = z.infer<typeof statusSchema>;

/** An ordered list of statuses, defined by the org. */
export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  statuses: z.array(statusSchema).min(1).max(50),
});
export type Workflow = z.infer<typeof workflowSchema>;

export type Actor =
  | { kind: "person"; id: string }
  | { kind: "agent"; id: string }
  /** A plugin acting through its `ctx` (spec 70 milestone 2); `id` is the plugin's name. */
  | { kind: "plugin"; id: string }
  | { kind: "system" };

/** What an item is waiting on in its current status. */
export type Waiting =
  | { on: "run"; agentId: string }
  | { on: "person"; userId: string }
  | { on: "decision" }
  | { on: "nothing" };

/** Everything the reconciler needs to know about an item. */
export interface ItemState {
  statusId: string;
  waiting: Waiting;
  /** Set when a run or a plugin failed here. The item is stopped until it is retried or moved. */
  error: string | null;
  /** Counts entries into a status, so a late result from an earlier stay can be told apart. */
  stay: number;
}

/** Something that happened to an item. */
export type ItemEvent =
  /** The item was created, in the workflow's first status or a named one. */
  | { type: "created"; statusId?: string }
  /** The agent's run for stay `stay` ended. `runId` is the store's, for the timeline to link. */
  | { type: "run.ended"; stay: number; outcome: "done" | "rejected"; runId?: string }
  | { type: "run.failed"; stay: number; error: string; runId?: string }
  /** The person who owns the status finished or rejected the work. */
  | { type: "person.finished"; by: Actor; outcome: "done" | "rejected" }
  /** A person decided on an item waiting for a decision. */
  | { type: "decided"; by: Actor; decision: "approve" | "reject" }
  /** Someone moved the item by hand. */
  | { type: "moved"; by: Actor; to: string }
  /** Try the current status again after an error. */
  | { type: "retried"; by: Actor };

/** What the outside world must do after an event. The reconciler never does it itself. */
export type Effect =
  | { type: "run.start"; agentId: string; statusId: string; brief: string; stay: number }
  | { type: "run.cancel"; stay: number }
  | { type: "inbox.add"; userId: string; statusId: string; reason: "work" }
  | { type: "decision.ask"; statusId: string }
  | { type: "entered"; from: string | null; to: string; by: Actor }
  | { type: "stopped"; statusId: string; error: string };

export interface Step {
  state: ItemState;
  effects: Effect[];
}

/** Why an event was refused. The state is unchanged. */
export class FlowError extends Error {
  constructor(
    readonly code:
      | "unknown_status"
      | "not_waiting"
      | "needs_decision"
      | "not_a_person"
      | "no_error",
    message: string,
  ) {
    super(message);
    this.name = "FlowError";
  }
}
