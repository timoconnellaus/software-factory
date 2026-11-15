// One step of an item: the kernel's `apply`, then its new state, its timeline and its effects written
// in one D1 batch. Every write that moves an item goes through `advance` (or createItem).
import { guardChanged, toStatement } from "@software-factory/db";
import {
  type Actor,
  apply,
  type Effect,
  type ItemEvent,
  type ItemState,
  type Waiting,
  type Workflow,
} from "@software-factory/flow";
import { type FlowDb, flowDb, iso, newId, StoreError, writeBatch } from "./db.ts";
import type { FlowEventsTable, FlowItemsTable, WaitingOn } from "./schema.ts";

export interface Item {
  id: string;
  orgId: string;
  projectId: string;
  number: number;
  title: string;
  body: string;
  statusId: string;
  waiting: Waiting;
  error: string | null;
  stay: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function toItem(row: FlowItemsTable): Item {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    number: row.number,
    title: row.title,
    body: row.body,
    statusId: row.status_id,
    waiting: waitingOf(row.waiting_on, row.waiting_ref),
    error: row.error,
    stay: row.stay,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function waitingOf(on: WaitingOn, ref: string | null): Waiting {
  if (on === "run") return { on, agentId: ref ?? "" };
  if (on === "person") return { on, userId: ref ?? "" };
  return { on };
}

/** The item's columns for a kernel state. */
export function stateColumns(state: ItemState) {
  const { waiting } = state;
  return {
    status_id: state.statusId,
    waiting_on: waiting.on,
    waiting_ref:
      waiting.on === "run" ? waiting.agentId : waiting.on === "person" ? waiting.userId : null,
    error: state.error,
    stay: state.stay,
  } satisfies Partial<FlowItemsTable>;
}

/** One timeline row. */
export function timelineRow(
  d1: D1Database,
  db: FlowDb,
  row: Omit<FlowEventsTable, "id" | "actor" | "data"> & { actor: Actor; data: unknown },
): D1PreparedStatement {
  return toStatement(
    d1,
    db.insertInto("flow_events").values({
      ...row,
      id: newId("fev_"),
      actor: JSON.stringify(row.actor),
      data: JSON.stringify(row.data),
    }),
  );
}

/**
 * The timeline rows for an event and its effects, numbered from `seq`, and the statements that carry
 * the effects out. `inbox.add`, `decision.ask`, `entered` and `stopped` need nothing beyond the
 * item's own columns and their timeline row.
 */
export function stepStatements(
  d1: D1Database,
  db: FlowDb,
  item: { id: string; orgId: string },
  seq: number,
  event: ItemEvent,
  effects: Effect[],
  actor: Actor,
  now: string,
): D1PreparedStatement[] {
  const base = { org_id: item.orgId, item_id: item.id, actor, created_at: now };
  const statements = [timelineRow(d1, db, { ...base, seq, kind: "event", data: event })];
  effects.forEach((effect, i) => {
    statements.push(
      timelineRow(d1, db, { ...base, seq: seq + 1 + i, kind: "effect", data: effect }),
    );
  });
  for (const effect of effects) {
    if (effect.type === "run.start") {
      const run = {
        id: newId("frun_"),
        org_id: item.orgId,
        item_id: item.id,
        agent_id: effect.agentId,
        status_id: effect.statusId,
        stay: effect.stay,
        brief: effect.brief,
        status: "queued" as const,
        fencing_token: 0,
        created_at: now,
      };
      statements.push(toStatement(d1, db.insertInto("flow_runs").values(run)));
    } else if (effect.type === "run.cancel") {
      const cancel = db
        .updateTable("flow_runs")
        .set({ status: "cancelled", finished_at: now })
        .where("item_id", "=", item.id)
        .where("stay", "=", effect.stay)
        .where("status", "in", ["queued", "claimed"]);
      statements.push(toStatement(d1, cancel));
    }
  }
  return statements;
}

/** What `advance` may add to its batch. */
export interface StepExtras {
  /** Statements that go first (a guarded update of the run that ended, say). */
  before?: D1PreparedStatement[];
  /** A comment appended after the event and its effects. */
  comment?: { actor: Actor; text: string };
}

/**
 * Applies `event` to the item and writes the result in one batch. A FlowError from the kernel
 * propagates unchanged and writes nothing. The item's update is conditional on the `stay` and
 * `updated_at` it was read with, and the timeline's (item_id, seq) is unique, so of two writers
 * that read the same item only one advances it; the other gets a conflict.
 */
export async function advance(
  d1: D1Database,
  itemId: string,
  event: ItemEvent,
  actor: Actor,
  extras: StepExtras = {},
): Promise<Item> {
  const db = flowDb(d1);
  const row = await db
    .selectFrom("flow_items as i")
    .innerJoin("flow_projects as p", "p.id", "i.project_id")
    .innerJoin("flow_workflows as w", "w.id", "p.workflow_id")
    .selectAll("i")
    .select("w.definition")
    .select((eb) =>
      eb
        .selectFrom("flow_events as e")
        .select((e) => e.fn.max("e.seq").as("m"))
        .whereRef("e.item_id", "=", "i.id")
        .as("last_seq"),
    )
    .where("i.id", "=", itemId)
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", `No item ${itemId}.`);
  const { definition, last_seq, ...current } = row;
  const workflow = JSON.parse(definition) as Workflow;
  const item = toItem(current);
  const { statusId, waiting, error, stay } = item;
  const step = apply(workflow, { statusId, waiting, error, stay }, event);

  const now = iso();
  const next: FlowItemsTable = { ...current, ...stateColumns(step.state), updated_at: now };
  const seq = (last_seq ?? 0) + 1;
  const statements = [
    ...(extras.before ?? []),
    toStatement(
      d1,
      db
        .updateTable("flow_items")
        .set({ ...stateColumns(step.state), updated_at: now })
        .where("id", "=", itemId)
        .where("stay", "=", current.stay)
        .where("updated_at", "=", current.updated_at),
    ),
    guardChanged(d1, "flow_items"),
    ...stepStatements(d1, db, item, seq, event, step.effects, actor, now),
  ];
  if (extras.comment) {
    statements.push(
      timelineRow(d1, db, {
        org_id: item.orgId,
        item_id: itemId,
        seq: seq + 1 + step.effects.length,
        kind: "comment",
        actor: extras.comment.actor,
        data: { text: extras.comment.text },
        created_at: now,
      }),
    );
  }
  await writeBatch(d1, statements);
  return toItem(next);
}
