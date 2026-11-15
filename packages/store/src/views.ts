// The views the desktop app polls: a project's board, a person's inbox (in one org, or across all
// of theirs), and runs with their items. Each list is capped (AGENTS.md cost rule 2) and carries the
// names a card shows, so the app needs no second read.
import { readBatch } from "@software-factory/db";
import type { Status, Workflow } from "@software-factory/flow";
import { sql } from "kysely";
import { flowDb, StoreError } from "./db.ts";
import { type Run, toRun } from "./runs.ts";
import type { FlowItemsTable, FlowRunRow } from "./schema.ts";
import { type Item, toItem } from "./step.ts";

/** The most items `board` returns. */
export const BOARD_LIMIT = 500;
/** The most items in each of `inbox`'s lists. */
export const INBOX_LIMIT = 100;
/** The most orgs `inboxAll` covers, and the most items in each of an org's lists. */
export const INBOX_ALL_ORGS = 10;
export const INBOX_ALL_LIMIT = 50;
/** The most runs `agentRuns` returns. */
export const AGENT_RUNS_LIMIT = 50;

/** An item as the views list it: with its project's name and key and its status's name. */
export interface ListedItem extends Item {
  projectName: string;
  projectKey: string;
  /** The status's name in the project's workflow (its id, if the workflow no longer has it). */
  statusName: string;
}

/**
 * The item columns plus project_name, project_key and status_name: the project and its workflow by
 * primary key, and the status's name picked out of the workflow's JSON in SQL, so a list never
 * ships a workflow per item.
 */
const LISTED = `SELECT i.*, p.name AS project_name, p.key AS project_key,
    (SELECT json_extract(s.value, '$.name') FROM json_each(w.definition, '$.statuses') AS s
      WHERE json_extract(s.value, '$.id') = i.status_id) AS status_name
  FROM flow_items AS i
  JOIN flow_projects AS p ON p.id = i.project_id
  JOIN flow_workflows AS w ON w.id = p.workflow_id`;

type ListedRow = FlowItemsTable & {
  project_name: string;
  project_key: string;
  status_name: string | null;
};

function toListed(row: ListedRow): ListedItem {
  const { project_name, project_key, status_name, ...item } = row;
  return {
    ...toItem(item),
    projectName: project_name,
    projectKey: project_key,
    statusName: status_name ?? item.status_id,
  };
}

/** What an inbox list waits on. */
type Waits = { on: "person"; userId: string } | { on: "decision" } | { on: "run" };

/**
 * One statement: for each org, its oldest `limit` items waiting on `waits`, each org's arm with its
 * own LIMIT, joined by UNION ALL. A person's work and decisions read flow_items_inbox_idx; items
 * waiting on a run read flow_items_working_idx.
 */
function waitingIn(
  d1: D1Database,
  orgIds: string[],
  waits: Waits,
  limit: number,
): D1PreparedStatement {
  const params: unknown[] = [];
  const arms = orgIds.map((orgId) => {
    params.push(orgId);
    let where = `i.org_id = ?${params.length} AND i.waiting_on = '${waits.on}'`;
    if (waits.on === "person") {
      params.push(waits.userId);
      where += ` AND i.waiting_ref = ?${params.length}`;
    } else if (waits.on === "decision") {
      where += " AND i.waiting_ref IS NULL";
    }
    return `SELECT * FROM (${LISTED} WHERE ${where} ORDER BY i.updated_at LIMIT ${Math.trunc(limit)})`;
  });
  return d1.prepare(arms.join(" UNION ALL ")).bind(...params);
}

/** Each statement's rows as listed items, oldest first. */
async function listedBatch(d1: D1Database, statements: D1PreparedStatement[]) {
  const results = await d1.batch<ListedRow>(statements);
  return results.map((r) =>
    r.results.map(toListed).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
  );
}

/**
 * A project's items in its workflow's columns, each column in item-number order. At most
 * BOARD_LIMIT items, taken in status then number order; `truncated` says some were left out.
 */
export async function board(
  d1: D1Database,
  projectId: string,
): Promise<{ columns: { status: Status; items: ListedItem[] }[]; truncated: boolean }> {
  const db = flowDb(d1);
  const [projects, rows] = await readBatch(d1, [
    db
      .selectFrom("flow_projects as p")
      .innerJoin("flow_workflows as w", "w.id", "p.workflow_id")
      .select(["w.definition", "p.name", "p.key"])
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
  const names = new Map(workflow.statuses.map((s) => [s.id, s.name]));
  const items = rows.slice(0, BOARD_LIMIT).map((row) => ({
    ...toItem(row),
    projectName: project.name,
    projectKey: project.key,
    statusName: names.get(row.status_id) ?? row.status_id,
  }));
  return {
    columns: workflow.statuses.map((status) => ({
      status,
      items: items.filter((i) => i.statusId === status.id),
    })),
    truncated: rows.length > BOARD_LIMIT,
  };
}

/**
 * What waits on a person: items they own the work on, and the org's items waiting on a decision.
 * At most INBOX_LIMIT in each list, oldest first; `truncated` says either list was cut.
 */
export async function inbox(
  d1: D1Database,
  orgId: string,
  userId: string,
): Promise<{
  work: ListedItem[];
  decisions: ListedItem[];
  done: DoneItem[];
  truncated: boolean;
}> {
  const statements = [
    waitingIn(d1, [orgId], { on: "person", userId }, INBOX_LIMIT + 1),
    waitingIn(d1, [orgId], { on: "decision" }, INBOX_LIMIT + 1),
    doneBy(d1, orgId, userId),
  ];
  const [work, decisions, done] = await d1.batch<ListedRow & { done_at: string }>(statements);
  const oldestFirst = (rows: ListedRow[]) =>
    rows.map(toListed).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const w = oldestFirst(work?.results ?? []);
  const d = oldestFirst(decisions?.results ?? []);
  return {
    work: w.slice(0, INBOX_LIMIT),
    decisions: d.slice(0, INBOX_LIMIT),
    done: (done?.results ?? [])
      .map(({ done_at, ...row }) => ({ ...toListed(row), doneAt: done_at }))
      .sort((a, b) => b.doneAt.localeCompare(a.doneAt)),
    truncated: w.length > INBOX_LIMIT || d.length > INBOX_LIMIT,
  };
}

/** The most items in the inbox's `done` list. */
export const INBOX_DONE_LIMIT = 30;

/** An item a person finished or decided, with when they last did. */
export interface DoneItem extends ListedItem {
  doneAt: string;
}

/**
 * The last INBOX_DONE_LIMIT items `userId` finished or decided in the org, newest first: their
 * newest 100 such timeline events (flow_events_person_done_idx, migration 0434), one row per item.
 * The expressions and the partial index's WHERE are the index's own, word for word, so SQLite
 * uses it; the GROUP BY sorts those 100 rows at most.
 */
function doneBy(d1: D1Database, orgId: string, userId: string): D1PreparedStatement {
  return d1
    .prepare(
      `SELECT i.*, p.name AS project_name, p.key AS project_key,
          (SELECT json_extract(s.value, '$.name') FROM json_each(w.definition, '$.statuses') AS s
            WHERE json_extract(s.value, '$.id') = i.status_id) AS status_name,
          d.done_at
        FROM (SELECT item_id, MAX(created_at) AS done_at FROM (
            SELECT item_id, created_at FROM flow_events
              WHERE org_id = ?1 AND json_extract(actor, '$.id') = ?2
                AND kind = 'event' AND json_extract(data, '$.type') IN ('person.finished', 'decided')
                AND json_extract(actor, '$.kind') = 'person'
              ORDER BY created_at DESC LIMIT 100)
          GROUP BY item_id ORDER BY done_at DESC LIMIT ${INBOX_DONE_LIMIT}) AS d
        JOIN flow_items AS i ON i.id = d.item_id
        JOIN flow_projects AS p ON p.id = i.project_id
        JOIN flow_workflows AS w ON w.id = p.workflow_id`,
    )
    .bind(orgId, userId);
}

export interface OrgInbox {
  orgId: string;
  name: string;
  /** Items waiting on the person. */
  work: ListedItem[];
  /** Items waiting on a decision. */
  decisions: ListedItem[];
  /** Items waiting on an agent's run. */
  working: ListedItem[];
}

/**
 * What waits on a person in every org they are a member of (core_member): at most INBOX_ALL_ORGS
 * orgs, by name, and in each at most INBOX_ALL_LIMIT items per list, oldest first. Two D1 requests:
 * the orgs, then one batch of three statements (one per list, an arm per org).
 */
export async function inboxAll(d1: D1Database, userId: string): Promise<OrgInbox[]> {
  const { results: orgs } = await d1
    .prepare(
      `SELECT o.id, o.name FROM core_member AS m
        JOIN core_organization AS o ON o.id = m.organization_id
        WHERE m.user_id = ? ORDER BY o.name, o.id LIMIT ${INBOX_ALL_ORGS}`,
    )
    .bind(userId)
    .all<{ id: string; name: string }>();
  if (orgs.length === 0) return [];
  const ids = orgs.map((o) => o.id);
  const [work = [], decisions = [], working = []] = await listedBatch(d1, [
    waitingIn(d1, ids, { on: "person", userId }, INBOX_ALL_LIMIT),
    waitingIn(d1, ids, { on: "decision" }, INBOX_ALL_LIMIT),
    waitingIn(d1, ids, { on: "run" }, INBOX_ALL_LIMIT),
  ]);
  const of = (list: ListedItem[], orgId: string) => list.filter((i) => i.orgId === orgId);
  return orgs.map((o) => ({
    orgId: o.id,
    name: o.name,
    work: of(work, o.id),
    decisions: of(decisions, o.id),
    working: of(working, o.id),
  }));
}

/**
 * A run as the views show it: an item's run with its item's title and number and its project's key,
 * or a chat's run with the chat's title (the item fields null).
 */
export interface ListedRun extends Run {
  itemTitle: string | null;
  itemNumber: number | null;
  projectKey: string | null;
  chatTitle: string | null;
}

/** Runs with their item and its project, or their chat (each by primary key). */
function listedRuns(d1: D1Database) {
  return flowDb(d1)
    .selectFrom("flow_runs as r")
    .leftJoin("flow_items as i", "i.id", "r.item_id")
    .leftJoin("flow_projects as p", "p.id", "i.project_id")
    .leftJoin("flow_chats as c", "c.id", "r.chat_id")
    .selectAll("r")
    .select(["i.title as item_title", "i.number as item_number", "p.key as project_key"])
    .select("c.title as chat_title");
}

function toListedRun(
  row: FlowRunRow & {
    item_title: string | null;
    item_number: number | null;
    project_key: string | null;
    chat_title: string | null;
  },
): ListedRun {
  const { item_title, item_number, project_key, chat_title, ...run } = row;
  return {
    ...toRun(run),
    itemTitle: item_title,
    itemNumber: item_number,
    projectKey: project_key,
    chatTitle: chat_title,
  };
}

/** An item's runs, by stay (flow_runs_item_idx). */
export async function itemRuns(d1: D1Database, itemId: string): Promise<ListedRun[]> {
  const rows = await listedRuns(d1).where("r.item_id", "=", itemId).orderBy("r.stay").execute();
  return rows.map(toListedRun);
}

/** An agent's newest `limit` runs (at most AGENT_RUNS_LIMIT), newest first (flow_runs_agent_idx). */
export async function agentRuns(
  d1: D1Database,
  orgId: string,
  agentId: string,
  limit: number,
): Promise<ListedRun[]> {
  const rows = await listedRuns(d1)
    .where("r.agent_id", "=", agentId)
    .where("r.org_id", "=", orgId)
    .orderBy("r.created_at", "desc")
    .orderBy(sql`r.rowid`, "desc")
    .limit(Math.max(1, Math.min(limit, AGENT_RUNS_LIMIT)))
    .execute();
  return rows.map(toListedRun);
}

/** One run with its item and project (or its chat), or null. */
export async function getListedRun(d1: D1Database, runId: string): Promise<ListedRun | null> {
  const row = await listedRuns(d1).where("r.id", "=", runId).executeTakeFirst();
  return row ? toListedRun(row) : null;
}
