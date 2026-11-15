// The whole permission model: the caller is a member of the org the call names, and every project,
// item, workflow and agent the call names belongs to that org. One query answers both.
import { OpError } from "./operation.ts";

/** The ids an input names, by kind. */
interface Named {
  projectId?: string;
  itemId?: string;
  workflowId?: string;
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
  if (projectId) out.projectId = projectId;
  if (itemId) out.itemId = itemId;
  if (workflowId) out.workflowId = workflowId;
  return out;
}

const TABLES = {
  projectId: ["flow_projects", "project"],
  itemId: ["flow_items", "item"],
  workflowId: ["flow_workflows", "workflow"],
} as const;

/**
 * Refuses the call unless `userId` is a member of `orgId` (core_member's unique (organization_id,
 * user_id) index) and everything the input names is in that org (each by primary key). Something
 * in another org is answered as not found, the same as something that doesn't exist.
 */
export async function checkScope(
  d1: D1Database,
  orgId: string,
  userId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const ids = named(input);
  const columns = [
    "EXISTS (SELECT 1 FROM core_member WHERE organization_id = ?1 AND user_id = ?2) AS member",
  ];
  const params: unknown[] = [orgId, userId];
  for (const key of ["projectId", "itemId", "workflowId"] as const) {
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
  for (const key of ["projectId", "itemId", "workflowId"] as const) {
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
