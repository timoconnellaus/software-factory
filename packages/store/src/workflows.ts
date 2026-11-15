// An org's workflows: stored as the kernel's Workflow, checked before every write.
import { checkWorkflow, type Workflow, type WorkflowProblem } from "@software-factory/flow";
import { flowDb, iso, newId, StoreError } from "./db.ts";

export interface StoredWorkflow {
  id: string;
  orgId: string;
  workflow: Workflow;
  createdAt: string;
  updatedAt: string;
}

/** A workflow without its id: the store gives it one. */
export interface WorkflowInput {
  name: string;
  statuses: unknown[];
}

export type WorkflowWrite =
  | { ok: true; workflow: StoredWorkflow }
  | { ok: false; problems: WorkflowProblem[] };

type Row = {
  id: string;
  org_id: string;
  definition: string;
  created_at: string;
  updated_at: string;
};

function toWorkflow(row: Row): StoredWorkflow {
  return {
    id: row.id,
    orgId: row.org_id,
    workflow: JSON.parse(row.definition) as Workflow,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createWorkflow(
  d1: D1Database,
  orgId: string,
  input: WorkflowInput,
): Promise<WorkflowWrite> {
  const id = newId("fwf_");
  const checked = checkWorkflow({ ...input, id });
  if (!checked.ok) return checked;
  const now = iso();
  const row: Row = {
    id,
    org_id: orgId,
    definition: JSON.stringify(checked.workflow),
    created_at: now,
    updated_at: now,
  };
  await flowDb(d1)
    .insertInto("flow_workflows")
    .values({ ...row, name: checked.workflow.name })
    .execute();
  return { ok: true, workflow: toWorkflow(row) };
}

export async function updateWorkflow(
  d1: D1Database,
  id: string,
  input: WorkflowInput,
): Promise<WorkflowWrite> {
  const checked = checkWorkflow({ ...input, id });
  if (!checked.ok) return checked;
  const row = await flowDb(d1)
    .updateTable("flow_workflows")
    .set({
      name: checked.workflow.name,
      definition: JSON.stringify(checked.workflow),
      updated_at: iso(),
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", `No workflow ${id}.`);
  return { ok: true, workflow: toWorkflow(row) };
}

export async function getWorkflow(d1: D1Database, id: string): Promise<StoredWorkflow | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_workflows")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toWorkflow(row) : null;
}

export async function listWorkflows(d1: D1Database, orgId: string): Promise<StoredWorkflow[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_workflows")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("name")
    .execute();
  return rows.map(toWorkflow);
}
