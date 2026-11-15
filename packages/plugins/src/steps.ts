// The one way an item event is applied with plugins around it. Every caller that moves an item (a
// person's or agent's flow.item.* call, a run's hand-back or failure, the lease sweep, a plugin's
// own ctx.move and ctx.createItem) comes through here, so the order is always:
//   1. if the event would take the item out of its status (worked out with the pure kernel, without
//      writing), `leaving`; a refusal stops it there;
//   2. the event, applied through the store;
//   3. `runEnded` if a run ended, then `entered` if the item entered a status;
// and then the moves the plugins asked for, each through here again, at most MOVE_CHAIN_LIMIT.
import { type Actor, apply, type Effect, FlowError, type ItemEvent } from "@software-factory/flow";
import {
  applyEventStep,
  createItem,
  endRun,
  expireRuns,
  getRun,
  type Item,
  loadItem,
  type Run,
  type RunEnding,
  StoreError,
  stopItem,
} from "@software-factory/store";
import { type DispatchOutcome, dispatch, Session } from "./dispatch.ts";
import {
  MOVE_CHAIN_LIMIT,
  type PluginHostEnv,
  PluginRefusal,
  type PluginRun,
  pluginItem,
} from "./types.ts";

type Entered = Extract<Effect, { type: "entered" }>;
type Move = DispatchOutcome["moves"][number];
const enteredOf = (effects: Effect[]) =>
  effects.find((e): e is Entered => e.type === "entered") ?? null;

function pluginRun(run: Run): PluginRun {
  return {
    id: run.id,
    agentId: run.agentId,
    statusId: run.statusId,
    outcome: run.status === "done" && run.result ? run.result.outcome : "failed",
    summary: run.result?.summary ?? run.error ?? "",
  };
}

/** The item's workflow's status ids, which `ctx.move` may name. */
async function statusIdsOf(env: PluginHostEnv, itemId: string): Promise<string[]> {
  return (await loadItem(env.DB, itemId)).workflow.statuses.map((s) => s.id);
}

/**
 * Asks the org's plugins whether the item may leave its status for `to`. Null when none refuses
 * and none fails; otherwise what happened (the dispatch has not stopped the item).
 */
async function askLeaving(
  session: Session,
  item: Item,
  statusIds: string[],
  from: string,
  to: string,
): Promise<DispatchOutcome | null> {
  const out = await dispatch(
    session.env,
    item.orgId,
    "leaving",
    { item: pluginItem(item), from, to },
    { item, statusIds, stop: false, session },
  );
  return out.refusal || out.failure ? out : null;
}

/** After a step: `runEnded`, then `entered`, then the plugins' moves and new items. */
async function after(
  session: Session,
  item: Item,
  effects: Effect[],
  extra: { run?: Run; retried?: boolean; statusIds?: string[] } = {},
): Promise<Item> {
  const plugins = await session.plugins(item.orgId);
  if (plugins.length === 0) return item;
  const statusIds = extra.statusIds ?? (await statusIdsOf(session.env, item.id));
  const moves: Move[] = [];
  const created: Item[] = [];
  const base = { item, statusIds, session };
  if (extra.run) {
    const out = await dispatch(
      session.env,
      item.orgId,
      "runEnded",
      { item: pluginItem(item), run: pluginRun(extra.run) },
      base,
    );
    created.push(...out.created);
    if (out.stopped) return settle(session, out.stopped, [], created);
    moves.push(...out.moves);
  }
  const entered = enteredOf(effects);
  // A retry runs the status again: its `entered` hooks run again too.
  const into = entered ?? (extra.retried ? { from: item.statusId, to: item.statusId } : null);
  if (into) {
    const out = await dispatch(
      session.env,
      item.orgId,
      "entered",
      { item: pluginItem(item), from: into.from, to: into.to },
      base,
    );
    created.push(...out.created);
    if (out.stopped) return settle(session, out.stopped, [], created);
    moves.push(...out.moves);
  }
  return settle(session, item, moves, created);
}

/** The plugins' follow-ups: hooks for the items they created, then their moves, in order. */
async function settle(session: Session, item: Item, moves: Move[], created: Item[]): Promise<Item> {
  for (const made of created) await afterCreated(session, made);
  let current = item;
  for (const { plugin, to } of moves) {
    session.moves++;
    if (session.moves > MOVE_CHAIN_LIMIT) {
      return stopItem(
        session.env.DB,
        current.id,
        `Plugins moved this item more than ${MOVE_CHAIN_LIMIT} times in a row, so it was stopped.`,
      );
    }
    const by: Actor = { kind: "plugin", id: plugin };
    try {
      current = await step(session, current.id, { type: "moved", by, to }, by);
    } catch (error) {
      if (!(error instanceof PluginRefusal || error instanceof FlowError)) throw error;
      return stopItem(
        session.env.DB,
        current.id,
        `Plugin "${plugin}" moved this item to "${to}", which wasn't allowed: ${error.message}`,
      );
    }
    if (current.error) return current;
  }
  return current;
}

/** `entered` for an item just created in its first status, and what its plugins then asked for. */
export function afterCreated(session: Session, item: Item): Promise<Item> {
  return after(session, item, [
    { type: "entered", from: null, to: item.statusId, by: { kind: "system" } },
  ]);
}

async function step(
  session: Session,
  itemId: string,
  event: ItemEvent,
  actor: Actor,
): Promise<Item> {
  const { env } = session;
  const loaded = await loadItem(env.DB, itemId);
  const plugins = await session.plugins(loaded.item.orgId);
  if (plugins.length > 0) {
    const { item, workflow } = loaded;
    const preview = apply(
      workflow,
      { statusId: item.statusId, waiting: item.waiting, error: item.error, stay: item.stay },
      event,
    );
    const entered = enteredOf(preview.effects);
    if (entered && entered.from !== null) {
      const statusIds = workflow.statuses.map((s) => s.id);
      const said = await askLeaving(session, item, statusIds, entered.from, entered.to);
      if (said?.refusal) throw new PluginRefusal(said.refusal.plugin, said.refusal.reason);
      if (said?.failure) {
        return stopItem(env.DB, item.id, said.failure.message, {
          kind: "plugin",
          id: said.failure.plugin,
        });
      }
    }
  }
  const stepped = await applyEventStep(env.DB, itemId, event, actor);
  return after(session, stepped.item, stepped.effects, {
    retried: event.type === "retried",
    statusIds: loaded.workflow.statuses.map((s) => s.id),
  });
}

/**
 * Applies a kernel event to an item with the org's plugins around it. A FlowError (the event
 * doesn't fit) or a PluginRefusal (a `leaving` hook said no) is thrown and nothing is written; a
 * plugin failure stops the item and returns it stopped.
 */
export function applyItemEvent(
  env: PluginHostEnv,
  itemId: string,
  event: ItemEvent,
  actor: Actor,
  session: Session = new Session(env),
): Promise<Item> {
  return step(session, itemId, event, actor);
}

/** Creates an item, then runs `entered` for its first status. */
export async function createItemWithHooks(
  env: PluginHostEnv,
  input: Parameters<typeof createItem>[1],
  session: Session = new Session(env),
): Promise<Item> {
  const item = await createItem(env.DB, input);
  return afterCreated(session, item);
}

/**
 * Ends a claimed run (the runner's hand-back or failure) with the org's plugins around it. When
 * the run's result would move the item, `leaving` is asked first: a refusal or a failure there
 * records the run as done and stops the item with the reason. Then `runEnded`, then `entered`.
 */
export async function endRunWithHooks(
  env: PluginHostEnv,
  runId: string,
  fencingToken: number,
  ending: RunEnding,
  session: Session = new Session(env),
): Promise<Item> {
  let end = ending;
  if (end.status === "done") {
    const run = await getRun(env.DB, runId);
    if (!run) throw new StoreError("not_found", `No run ${runId}.`);
    // A chat's run has no item and no plugins around it: it ends through the store's endChatRun.
    if (run.itemId === null) throw new StoreError("invalid", `Run ${runId} is a chat's run.`);
    const loaded = await loadItem(env.DB, run.itemId);
    const { item, workflow } = loaded;
    if ((await session.plugins(item.orgId)).length > 0) {
      let entered: Entered | null = null;
      try {
        const state = {
          statusId: item.statusId,
          waiting: item.waiting,
          error: item.error,
          stay: item.stay,
        };
        const event = { type: "run.ended" as const, stay: run.stay, outcome: end.result.outcome };
        entered = enteredOf(apply(workflow, state, event).effects);
      } catch (error) {
        if (!(error instanceof FlowError)) throw error;
      }
      if (entered && entered.from !== null) {
        const statusIds = workflow.statuses.map((s) => s.id);
        const said = await askLeaving(session, item, statusIds, entered.from, entered.to);
        if (said?.refusal) {
          end = {
            ...end,
            stopWith: `Plugin "${said.refusal.plugin}" refused: ${said.refusal.reason}`,
          };
        } else if (said?.failure) {
          end = { ...end, stopWith: said.failure.message };
        }
      }
    }
  }
  const ended = await endRun(env.DB, runId, fencingToken, end);
  return after(session, ended.item, ended.effects, { run: ended.run });
}

/** The lease sweep (the minute cron) with `runEnded` for each run it fails. At most 10 a tick. */
export function expireRunsWithHooks(env: PluginHostEnv, now: number, limit = 10): Promise<number> {
  const session = new Session(env);
  return expireRuns(env.DB, now, limit, async (ended) => {
    await after(session, ended.item, ended.effects, { run: ended.run });
  });
}
