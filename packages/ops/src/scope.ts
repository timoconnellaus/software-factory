// The whole permission model: the caller is a member of the org the call names, and every project,
// item, workflow, run and agent the call names belongs to that org. One query answers both. (A
// `self` operation names no org: it reads only the caller's own orgs; see operation.ts.)
import { type Caller, OpError } from "./operation.ts";

/** The ids an input names, by kind. */
interface Named {
  projectId?: string;
  itemId?: string;
  workflowId?: string;
  runId?: string;
  /** An agent the input names: `agentId`, and every agent a workflow's statuses own. */
  agentIds: string[];
}

function named(input: Record<string, unknown>): Named {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const agentIds = new Set<string>();
  const agentId = str(input.agentId);
  if (agentId) agentIds.add(agentId);
  if (Array.isArray(input.statuses)) {
    for (const s of input.statuses) {
      const owner = (s as { owner?: { kind?: unknown; agentId?: unknown } } | null)?.owner;
      if (owner?.kind === "agent" && typeof owner.agentId === "string") {
        agentIds.add(owner.agentId);
      }
    }
  }
  const out: Named = { agentIds: [...agentIds] };
  const projectId = str(input.projectId);
  const itemId = str(input.itemId);
  const workflowId = str(input.workflowId);
  const runId = str(input.runId);
  if (projectId) out.projectId = projectId;
  if (itemId) out.itemId = itemId;
  if (workflowId) out.workflowId = workflowId;
  if (runId) out.runId = runId;
  return out;
}

const TABLES = {
  projectId: ["flow_projects", "project"],
  itemId: ["flow_items", "item"],
  workflowId: ["flow_workflows", "workflow"],
  runId: ["flow_runs", "run"],
} as const;

const KEYS = ["projectId", "itemId", "workflowId", "runId"] as const;

/**
 * Refuses the call unless `userId` is a member of `orgId` (core_member's unique (organization_id,
 * user_id) index) and everything the input names is in that org (each by primary key). Something
 * in another org is answered as not found, the same as something that doesn't exist.
 */
export async function checkScope(
  d1: D1Database,
  orgId: string,
  caller: Caller,
  input: Record<string, unknown>,
): Promise<void> {
  // An agent (through the MCP server) acts only in its run's org; a person in any org they're in.
  if (caller.kind === "agent" && caller.orgId !== orgId) {
    throw new OpError("forbidden", `This run's agent acts only in org ${caller.orgId}.`);
  }
  const ids = named(input);
  const columns = [
    caller.kind === "agent"
      ? "(?1 IS NOT NULL AND ?2 IS NOT NULL) AS member"
      : "EXISTS (SELECT 1 FROM core_member WHERE organization_id = ?1 AND user_id = ?2) AS member",
  ];
  const params: unknown[] = [orgId, caller.kind === "agent" ? caller.onBehalfOf : caller.id];
  for (const key of KEYS) {
    const value = ids[key];
    if (value === undefined) continue;
    params.push(value);
    columns.push(`(SELECT org_id FROM ${TABLES[key][0]} WHERE id = ?${params.length}) AS ${key}`);
  }
  if (ids.agentIds.length) {
    params.push(JSON.stringify(ids.agentIds));
    columns.push(
      `(SELECT count(*) FROM flow_agents WHERE org_id = ?1 AND id IN (SELECT value FROM json_each(?${params.length}))) AS agents`,
    );
  }
  const row = await d1
    .prepare(`SELECT ${columns.join(", ")}`)
    .bind(...params)
    .first<Record<string, unknown>>();
  if (!row?.member) throw new OpError("forbidden", `You are not a member of org ${orgId}.`);
  for (const key of KEYS) {
    const value = ids[key];
    if (value !== undefined && row[key] !== orgId) {
      throw new OpError("not_found", `No ${TABLES[key][1]} ${value} in this org.`);
    }
  }
  if (ids.agentIds.length && row.agents !== ids.agentIds.length) {
    throw new OpError(
      "not_found",
      `Not every agent named is in this org: ${ids.agentIds.join(", ")}.`,
    );
  }
}
