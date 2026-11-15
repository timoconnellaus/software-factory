import {
  type Actor,
  type Effect,
  FlowError,
  type ItemEvent,
  type ItemState,
  type Status,
  type Step,
  type Workflow,
} from "./model.ts";

const SYSTEM: Actor = { kind: "system" };

function find(workflow: Workflow, id: string): Status {
  const status = workflow.statuses.find((s) => s.id === id);
  if (!status) throw new FlowError("unknown_status", `"${id}" isn't a status in ${workflow.name}.`);
  return status;
}

/** Where an item goes from `status` on done or rejected, or null when there is nowhere to go. */
export function target(
  workflow: Workflow,
  status: Status,
  outcome: "done" | "rejected",
): string | null {
  const named = outcome === "done" ? status.onDone : status.onReject;
  if (named !== undefined) return named;
  const at = workflow.statuses.findIndex((s) => s.id === status.id);
  const neighbour = workflow.statuses[outcome === "done" ? at + 1 : at - 1];
  return neighbour ? neighbour.id : null;
}

/** Puts the item in `to` and hands it to that status's owner. */
function enter(workflow: Workflow, prev: ItemState | null, to: string, by: Actor): Step {
  const status = find(workflow, to);
  const stay = (prev?.stay ?? 0) + 1;
  const effects: Effect[] = [];
  if (prev?.waiting.on === "run") effects.push({ type: "run.cancel", stay: prev.stay });
  effects.push({ type: "entered", from: prev?.statusId ?? null, to, by });
  return hand(status, { statusId: to, waiting: { on: "nothing" }, error: null, stay }, effects);
}

/** Hands the item to its status's owner: starts a run, or puts it in a person's inbox. */
function hand(status: Status, state: ItemState, effects: Effect[]): Step {
  const { owner } = status;
  if (owner.kind === "agent") {
    effects.push({
      type: "run.start",
      agentId: owner.agentId,
      statusId: status.id,
      brief: status.brief,
      stay: state.stay,
    });
    return { state: { ...state, waiting: { on: "run", agentId: owner.agentId } }, effects };
  }
  if (owner.kind === "person") {
    effects.push({ type: "inbox.add", userId: owner.userId, statusId: status.id, reason: "work" });
    return { state: { ...state, waiting: { on: "person", userId: owner.userId } }, effects };
  }
  // Nobody owns it. If leaving takes a decision, ask for one now; otherwise it rests here.
  if (status.needsDecision) {
    effects.push({ type: "decision.ask", statusId: status.id });
    return { state: { ...state, waiting: { on: "decision" } }, effects };
  }
  return { state, effects };
}

/** The work in the current status is over: move on, or wait for a person's decision first. */
function finish(
  workflow: Workflow,
  state: ItemState,
  outcome: "done" | "rejected",
  by: Actor,
  decided: boolean,
): Step {
  const status = find(workflow, state.statusId);
  if (outcome === "done" && status.needsDecision && !decided) {
    return {
      state: { ...state, waiting: { on: "decision" } },
      effects: [{ type: "decision.ask", statusId: status.id }],
    };
  }
  const to = target(workflow, status, outcome);
  if (to === null) return { state: { ...state, waiting: { on: "nothing" } }, effects: [] };
  return enter(workflow, { ...state, waiting: { on: "nothing" } }, to, by);
}

/**
 * The whole engine: what an event does to an item. Pure, so replaying the same events gives the
 * same state. It returns the new state and what the outside world must now do. An event that
 * doesn't fit the item's state throws a FlowError and changes nothing.
 */
export function apply(workflow: Workflow, state: ItemState | null, event: ItemEvent): Step {
  if (event.type === "created") {
    const first = workflow.statuses[0];
    if (!first) throw new FlowError("unknown_status", `${workflow.name} has no statuses.`);
    return enter(workflow, null, event.statusId ?? first.id, SYSTEM);
  }
  if (!state) throw new FlowError("not_waiting", "The item doesn't exist yet.");
  const status = find(workflow, state.statusId);

  switch (event.type) {
    case "run.ended":
    case "run.failed": {
      // A result from an earlier stay (the item moved on, or was retried) no longer counts.
      if (state.waiting.on !== "run" || event.stay !== state.stay) return { state, effects: [] };
      if (event.type === "run.failed") {
        return {
          state: { ...state, waiting: { on: "nothing" }, error: event.error },
          effects: [{ type: "stopped", statusId: status.id, error: event.error }],
        };
      }
      return finish(
        workflow,
        state,
        event.outcome,
        { kind: "agent", id: state.waiting.agentId },
        false,
      );
    }
    case "person.finished": {
      if (state.waiting.on !== "person") {
        throw new FlowError("not_waiting", `${status.name} isn't waiting on a person.`);
      }
      if (event.by.kind !== "person")
        throw new FlowError("not_a_person", "Only a person can finish this.");
      // The owner finishing a status that needs a decision is that decision.
      return finish(workflow, state, event.outcome, event.by, true);
    }
    case "decided": {
      if (state.waiting.on !== "decision") {
        throw new FlowError("not_waiting", `${status.name} isn't waiting for a decision.`);
      }
      if (event.by.kind !== "person")
        throw new FlowError("not_a_person", "Only a person can decide.");
      return finish(
        workflow,
        state,
        event.decision === "approve" ? "done" : "rejected",
        event.by,
        true,
      );
    }
    case "moved": {
      if (status.needsDecision && event.by.kind !== "person") {
        throw new FlowError("needs_decision", `Leaving ${status.name} takes a person's decision.`);
      }
      return enter(workflow, state, event.to, event.by);
    }
    case "retried": {
      if (state.error === null) throw new FlowError("no_error", "Nothing failed here to retry.");
      const stay = state.stay + 1;
      return hand(status, { ...state, waiting: { on: "nothing" }, error: null, stay }, []);
    }
  }
}

/** Replays events from nothing. Events that don't fit are skipped, as they were when they arrived. */
export function replay(workflow: Workflow, events: ItemEvent[]): ItemState | null {
  let state: ItemState | null = null;
  for (const event of events) {
    try {
      state = apply(workflow, state, event).state;
    } catch (error) {
      if (!(error instanceof FlowError)) throw error;
    }
  }
  return state;
}
