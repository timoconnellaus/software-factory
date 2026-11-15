// An org's agents: a name, instructions, and the MCP servers its runs get. A status's owner names
// one by id.
import { readBatch } from "@software-factory/db";
import { flowDb, iso, newId, StoreError } from "./db.ts";
import type { FlowAgentsTable } from "./schema.ts";

export interface Agent {
  id: string;
  orgId: string;
  name: string;
  instructions: string;
  /** MCP server names its runs get. "factory" is the engine's own (flow ops and the plugin editor). */
  mcp: string[];
  createdAt: string;
}

type Row = FlowAgentsTable;

export function parseMcp(text: string | null | undefined): string[] {
  try {
    const value = JSON.parse(text ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toAgent(row: Row): Agent {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    instructions: row.instructions,
    mcp: parseMcp(row.mcp),
    createdAt: row.created_at,
  };
}

export async function createAgent(
  d1: D1Database,
  input: { orgId: string; name: string; instructions: string; mcp?: string[] },
): Promise<Agent> {
  const row: Row = {
    id: newId("fagt_"),
    org_id: input.orgId,
    name: input.name,
    instructions: input.instructions,
    mcp: JSON.stringify(input.mcp ?? []),
    created_at: iso(),
  };
  await flowDb(d1).insertInto("flow_agents").values(row).execute();
  return toAgent(row);
}

/** Changes an agent's name and instructions, and its MCP servers when `mcp` is given. */
export async function updateAgent(
  d1: D1Database,
  id: string,
  input: { name: string; instructions: string; mcp?: string[] },
): Promise<Agent> {
  const row = await flowDb(d1)
    .updateTable("flow_agents")
    .set({
      name: input.name,
      instructions: input.instructions,
      ...(input.mcp ? { mcp: JSON.stringify(input.mcp) } : {}),
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", `No agent ${id}.`);
  return toAgent(row);
}

/** The most agents `findBuilder` looks through. */
const BUILDER_SCAN_LIMIT = 200;

/**
 * The org's agent with the engine's "factory" MCP server that Chat should talk to: one named
 * "Builder" if there is one, else the first by name. Null when none has it. Reads
 * flow_agents_org_idx (an org has a handful of agents).
 */
export async function findBuilder(d1: D1Database, orgId: string): Promise<Agent | null> {
  const rows = await flowDb(d1)
    .selectFrom("flow_agents")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("name")
    .limit(BUILDER_SCAN_LIMIT)
    .execute();
  const builders = rows.map(toAgent).filter((a) => a.mcp.includes("factory"));
  return builders.find((a) => a.name === "Builder") ?? builders[0] ?? null;
}

export async function getAgent(d1: D1Database, id: string): Promise<Agent | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_agents")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toAgent(row) : null;
}

/** The item an agent's open run is on. */
export interface WorkingOn {
  itemId: string;
  itemTitle: string;
  itemNumber: number;
  projectKey: string;
}

/** The most open runs `listAgents` reads for the org's `workingOn`. */
const OPEN_RUNS_LIMIT = 500;

/**
 * The org's agents by name, each with `workingOn`: the item of its claimed run, else of its oldest
 * queued one, else null. The open runs are one read for the org: the items waiting on a run
 * (flow_items_inbox_idx), each one's run for its stay (flow_runs_item_idx) and project (by key).
 */
export async function listAgents(
  d1: D1Database,
  orgId: string,
): Promise<(Agent & { workingOn: WorkingOn | null })[]> {
  const db = flowDb(d1);
  const [rows, open] = await readBatch(d1, [
    db.selectFrom("flow_agents").selectAll().where("org_id", "=", orgId).orderBy("name"),
    db
      .selectFrom("flow_items as i")
      .innerJoin("flow_projects as p", "p.id", "i.project_id")
      .innerJoin("flow_runs as r", (join) =>
        join.onRef("r.item_id", "=", "i.id").onRef("r.stay", "=", "i.stay"),
      )
      .select(["r.agent_id", "r.status", "r.created_at", "i.id", "i.title", "i.number", "p.key"])
      .where("i.org_id", "=", orgId)
      .where("i.waiting_on", "=", "run")
      .where("r.status", "in", ["queued", "claimed"])
      .limit(OPEN_RUNS_LIMIT),
  ] as const);
  type Open = (typeof open)[number];
  // A claimed run before a queued one, then the older first.
  const first = (a: Open, b: Open) =>
    a.status !== b.status ? a.status === "claimed" : a.created_at < b.created_at;
  const working = new Map<string, Open>();
  for (const run of open) {
    const seen = working.get(run.agent_id);
    if (!seen || first(run, seen)) working.set(run.agent_id, run);
  }
  return rows.map((row) => {
    const run = working.get(row.id);
    return {
      ...toAgent(row),
      workingOn: run
        ? { itemId: run.id, itemTitle: run.title, itemNumber: run.number, projectKey: run.key }
        : null,
    };
  });
}
