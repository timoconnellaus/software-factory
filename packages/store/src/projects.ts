// An org's projects: a name, a key for item numbers, and the workflow its items move through.
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

export async function listProjects(d1: D1Database, orgId: string): Promise<Project[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_projects")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("name")
    .execute();
  return rows.map(toProject);
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
