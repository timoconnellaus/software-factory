// An org's projects: a name, a key for item numbers, and the workflow its items move through.
import { readBatch } from "@software-factory/db";
import { sql } from "kysely";
import { flowDb, iso, newId, StoreError } from "./db.ts";

export interface Project {
  id: string;
  orgId: string;
  name: string;
  key: string;
  workflowId: string;
  nextNumber: number;
  createdAt: string;
}

type Row = {
  id: string;
  org_id: string;
  name: string;
  key: string;
  workflow_id: string;
  next_number: number;
  created_at: string;
};

function toProject(row: Row): Project {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    key: row.key,
    workflowId: row.workflow_id,
    nextNumber: row.next_number,
    createdAt: row.created_at,
  };
}

export async function createProject(
  d1: D1Database,
  input: { orgId: string; name: string; key: string; workflowId: string },
): Promise<Project> {
  const row: Row = {
    id: newId("fprj_"),
    org_id: input.orgId,
    name: input.name,
    key: input.key,
    workflow_id: input.workflowId,
    next_number: 1,
    created_at: iso(),
  };
  await flowDb(d1).insertInto("flow_projects").values(row).execute();
  return toProject(row);
}

export async function getProject(d1: D1Database, id: string): Promise<Project | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_projects")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toProject(row) : null;
}

/**
 * The org's projects by name, each with `openCount`: its items not resting in a status nobody owns
 * (waiting on something, or stopped with an error). The counts are one grouped read of the partial
 * flow_items_open_idx, which holds only open items.
 */
export async function listProjects(
  d1: D1Database,
  orgId: string,
): Promise<(Project & { openCount: number })[]> {
  const db = flowDb(d1);
  const [rows, counts] = await readBatch(d1, [
    db.selectFrom("flow_projects").selectAll().where("org_id", "=", orgId).orderBy("name"),
    // The predicate is written as the index's WHERE, literally, so SQLite uses the partial index.
    db
      .selectFrom("flow_items")
      .select(["project_id", (eb) => eb.fn.countAll<number>().as("open")])
      .where("org_id", "=", orgId)
      .where(sql<boolean>`(waiting_on <> 'nothing' OR error IS NOT NULL)`)
      .groupBy("project_id"),
  ] as const);
  const open = new Map(counts.map((c) => [c.project_id, Number(c.open)]));
  return rows.map((row) => ({ ...toProject(row), openCount: open.get(row.id) ?? 0 }));
}

/** Points the project at another workflow. Its items keep their status ids. */
export async function setProjectWorkflow(
  d1: D1Database,
  projectId: string,
  workflowId: string,
): Promise<void> {
  const result = await flowDb(d1)
    .updateTable("flow_projects")
    .set({ workflow_id: workflowId })
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw new StoreError("not_found", `No project ${projectId}.`);
}
