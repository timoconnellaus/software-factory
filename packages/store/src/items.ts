// Items: created into their project's workflow, moved by kernel events, commented on, and read as a
// board, a timeline and an inbox.
import { guardChanged, readBatch, toStatement } from "@software-factory/db";
import {
  type Actor,
  apply,
  type ItemEvent,
  type Status,
  type Workflow,
} from "@software-factory/flow";
import { flowDb, iso, newId, StoreError, writeBatch } from "./db.ts";
import type { EntryKind, FlowEventsTable, FlowItemsTable } from "./schema.ts";
import {
  advance,
  type Item,
  type Stepped,
  stateColumns,
  stepStatements,
  timelineRow,
  toItem,
} from "./step.ts";

export type { Item } from "./step.ts";

/**
 * Creates an item in its project's workflow: takes the project's next number, applies the kernel's
 * `created` event, and writes the item, its timeline and its effects (a queued run, say) in one batch.
 */
export async function createItem(
  d1: D1Database,
  input: {
    orgId: string;
    projectId: string;
    title: string;
    body: string;
    createdBy: string;
    /** Plugin fields to start with. */
    fields?: Record<string, unknown>;
    /** Who the timeline says created it; default the person `createdBy`. */
    actor?: Actor;
  },
): Promise<Item> {
  const db = flowDb(d1);
  const project = await db
    .selectFrom("flow_projects as p")
    .innerJoin("flow_workflows as w", "w.id", "p.workflow_id")
    .select(["p.next_number", "w.definition"])
    .where("p.id", "=", input.projectId)
    .where("p.org_id", "=", input.orgId)
    .executeTakeFirst();
  if (!project) throw new StoreError("not_found", `No project ${input.projectId}.`);
  const workflow = JSON.parse(project.definition) as Workflow;
  const event: ItemEvent = { type: "created" };
  const step = apply(workflow, null, event);

  const now = iso();
  const number = project.next_number;
  const row: FlowItemsTable = {
    id: newId("fitm_"),
    org_id: input.orgId,
    project_id: input.projectId,
    number,
    title: input.title,
    body: input.body,
    ...stateColumns(step.state),
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
    fields: JSON.stringify(input.fields ?? {}),
  };
  const actor: Actor = input.actor ?? { kind: "person", id: input.createdBy };
  await writeBatch(d1, [
    toStatement(
      d1,
      db
        .updateTable("flow_projects")
        .set({ next_number: number + 1 })
        .where("id", "=", input.projectId)
        .where("next_number", "=", number),
    ),
    guardChanged(d1, "flow_projects.next_number"),
    toStatement(d1, db.insertInto("flow_items").values(row)),
    ...stepStatements(
      d1,
      db,
      { id: row.id, orgId: row.org_id },
      1,
      event,
      step.effects,
      actor,
      now,
    ),
  ]);
  return toItem(row);
}

/**
 * Applies a kernel event to an item: its new state, the event and its effects on the timeline, and
 * the effects carried out, in one batch. A FlowError propagates unchanged and writes nothing; a
 * concurrent change to the same item is a StoreError "conflict".
 */
export async function applyEvent(
  d1: D1Database,
  itemId: string,
  event: ItemEvent,
  actor: Actor,
): Promise<Item> {
  return (await advance(d1, itemId, event, actor)).item;
}

/** As applyEvent, with the effects the step carried out (for the plugin hooks around it). */
export function applyEventStep(
  d1: D1Database,
  itemId: string,
  event: ItemEvent,
  actor: Actor,
): Promise<Stepped> {
  return advance(d1, itemId, event, actor);
}

export function addComment(
  d1: D1Database,
  itemId: string,
  actor: Actor,
  text: string,
): Promise<void> {
  return appendEntry(d1, itemId, "comment", actor, { text });
}

/** Appends one entry (a comment, a card) to the item's timeline, after its last. */
export async function appendEntry(
  d1: D1Database,
  itemId: string,
  kind: "comment" | "card",
  actor: Actor,
  data: unknown,
): Promise<void> {
  const db = flowDb(d1);
  const item = await db
    .selectFrom("flow_items as i")
    .select("i.org_id")
    .select((eb) =>
      eb
        .selectFrom("flow_events as e")
        .select((e) => e.fn.max("e.seq").as("m"))
        .whereRef("e.item_id", "=", "i.id")
        .as("last_seq"),
    )
    .where("i.id", "=", itemId)
    .executeTakeFirst();
  if (!item) throw new StoreError("not_found", `No item ${itemId}.`);
  await writeBatch(d1, [
    timelineRow(d1, db, {
      org_id: item.org_id,
      item_id: itemId,
      seq: (item.last_seq ?? 0) + 1,
      kind,
      actor,
      data,
      created_at: iso(),
    }),
  ]);
}

export async function getItem(d1: D1Database, itemId: string): Promise<Item | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_items")
    .selectAll()
    .where("id", "=", itemId)
    .executeTakeFirst();
  return row ? toItem(row) : null;
}

/** The most items `board` returns (AGENTS.md cost rule 2). */
export const BOARD_LIMIT = 500;
/** The most entries `timeline` returns: the newest. */
export const TIMELINE_LIMIT = 500;
/** The most items in each of `inbox`'s lists. */
export const INBOX_LIMIT = 100;

/**
 * A project's items in its workflow's columns, each column in item-number order. At most
 * BOARD_LIMIT items, taken in status then number order; `truncated` says some were left out.
 */
export async function board(
  d1: D1Database,
  projectId: string,
): Promise<{ columns: { status: Status; items: Item[] }[]; truncated: boolean }> {
  const db = flowDb(d1);
  const [projects, rows] = await readBatch(d1, [
    db
      .selectFrom("flow_projects as p")
      .innerJoin("flow_workflows as w", "w.id", "p.workflow_id")
      .select("w.definition")
      .where("p.id", "=", projectId),
    db
      .selectFrom("flow_items")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("status_id")
      .orderBy("number")
      .limit(BOARD_LIMIT + 1),
  ] as const);
  const project = projects[0];
  if (!project) throw new StoreError("not_found", `No project ${projectId}.`);
  const workflow = JSON.parse(project.definition) as Workflow;
  const items = rows.slice(0, BOARD_LIMIT).map(toItem);
  return {
    columns: workflow.statuses.map((status) => ({
      status,
      items: items.filter((i) => i.statusId === status.id),
    })),
    truncated: rows.length > BOARD_LIMIT,
  };
}

export interface TimelineEntry {
  seq: number;
  kind: EntryKind;
  actor: Actor;
  data: unknown;
  createdAt: string;
}

type EntryRow = Pick<FlowEventsTable, "seq" | "kind" | "actor" | "data" | "created_at">;

function toEntry(r: EntryRow): TimelineEntry {
  return {
    seq: r.seq,
    kind: r.kind,
    actor: JSON.parse(r.actor) as Actor,
    data: JSON.parse(r.data) as unknown,
    createdAt: r.created_at,
  };
}

/**
 * An item's timeline in order: its newest TIMELINE_LIMIT entries, oldest first. `truncated` says
 * older ones were left out.
 */
export async function timeline(
  d1: D1Database,
  itemId: string,
): Promise<{ entries: TimelineEntry[]; truncated: boolean }> {
  const rows = await flowDb(d1)
    .selectFrom("flow_events")
    .select(["seq", "kind", "actor", "data", "created_at"])
    .where("item_id", "=", itemId)
    .orderBy("seq", "desc")
    .limit(TIMELINE_LIMIT + 1)
    .execute();
  return {
    entries: rows.slice(0, TIMELINE_LIMIT).reverse().map(toEntry),
    truncated: rows.length > TIMELINE_LIMIT,
  };
}

/** An item's newest `limit` comments, oldest first: what a run's prompt quotes. */
export async function recentComments(
  d1: D1Database,
  itemId: string,
  limit: number,
): Promise<TimelineEntry[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_events")
    .select(["seq", "kind", "actor", "data", "created_at"])
    .where("item_id", "=", itemId)
    .where("kind", "=", "comment")
    .orderBy("seq", "desc")
    .limit(limit)
    .execute();
  return rows.reverse().map(toEntry);
}

/**
 * What waits on a person: items they own the work on, and the org's items waiting on a decision.
 * At most INBOX_LIMIT in each list, oldest first; `truncated` says either list was cut.
 */
export async function inbox(
  d1: D1Database,
  orgId: string,
  userId: string,
): Promise<{ work: Item[]; decisions: Item[]; truncated: boolean }> {
  const db = flowDb(d1);
  const [work, decisions] = await readBatch(d1, [
    db
      .selectFrom("flow_items")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("waiting_on", "=", "person")
      .where("waiting_ref", "=", userId)
      .orderBy("updated_at")
      .limit(INBOX_LIMIT + 1),
    db
      .selectFrom("flow_items")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("waiting_on", "=", "decision")
      .where("waiting_ref", "is", null)
      .orderBy("updated_at")
      .limit(INBOX_LIMIT + 1),
  ] as const);
  return {
    work: work.slice(0, INBOX_LIMIT).map(toItem),
    decisions: decisions.slice(0, INBOX_LIMIT).map(toItem),
    truncated: work.length > INBOX_LIMIT || decisions.length > INBOX_LIMIT,
  };
}
