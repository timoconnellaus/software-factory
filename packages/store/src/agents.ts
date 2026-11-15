// An org's agents: a name and instructions. A status's owner names one by id.
import { flowDb, iso, newId, StoreError } from "./db.ts";

export interface Agent {
  id: string;
  orgId: string;
  name: string;
  instructions: string;
  createdAt: string;
}

type Row = { id: string; org_id: string; name: string; instructions: string; created_at: string };

function toAgent(row: Row): Agent {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    instructions: row.instructions,
    createdAt: row.created_at,
  };
}

export async function createAgent(
  d1: D1Database,
  input: { orgId: string; name: string; instructions: string },
): Promise<Agent> {
  const row: Row = {
    id: newId("fagt_"),
    org_id: input.orgId,
    name: input.name,
    instructions: input.instructions,
    created_at: iso(),
  };
  await flowDb(d1).insertInto("flow_agents").values(row).execute();
  return toAgent(row);
}

export async function updateAgent(
  d1: D1Database,
  id: string,
  input: { name: string; instructions: string },
): Promise<Agent> {
  const row = await flowDb(d1)
    .updateTable("flow_agents")
    .set({ name: input.name, instructions: input.instructions })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", `No agent ${id}.`);
  return toAgent(row);
}

export async function getAgent(d1: D1Database, id: string): Promise<Agent | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_agents")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toAgent(row) : null;
}

export async function listAgents(d1: D1Database, orgId: string): Promise<Agent[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_agents")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("name")
    .execute();
  return rows.map(toAgent);
}
