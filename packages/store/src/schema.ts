// The flow_* tables (packages/db/migrations/0430_flow.sql, 0431_flow_plugins.sql), as Kysely sees them.

export interface FlowWorkflowsTable {
  id: string;
  org_id: string;
  name: string;
  /** JSON: the Workflow from packages/flow. */
  definition: string;
  created_at: string;
  updated_at: string;
}

export interface FlowProjectsTable {
  id: string;
  org_id: string;
  name: string;
  key: string;
  workflow_id: string;
  next_number: number;
  created_at: string;
}

export interface FlowAgentsTable {
  id: string;
  org_id: string;
  name: string;
  instructions: string;
  /** JSON: the MCP server names this agent's runs get ("factory": the engine's own). */
  mcp: string;
  created_at: string;
}

export type WaitingOn = "run" | "person" | "decision" | "nothing";

export interface FlowItemsTable {
  id: string;
  org_id: string;
  project_id: string;
  number: number;
  title: string;
  body: string;
  status_id: string;
  waiting_on: WaitingOn;
  waiting_ref: string | null;
  error: string | null;
  stay: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** JSON: the item's plugin fields, field id to value. */
  fields: string;
}

export type EntryKind = "event" | "effect" | "comment" | "card";

export interface FlowEventsTable {
  id: string;
  org_id: string;
  item_id: string;
  seq: number;
  kind: EntryKind;
  /** JSON: an Actor. */
  actor: string;
  /** JSON: the ItemEvent, the Effect, `{ text }` for a comment, or a plugin's card. */
  data: string;
  created_at: string;
}

export type RunStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

export interface FlowRunsTable {
  id: string;
  org_id: string;
  item_id: string;
  agent_id: string;
  status_id: string;
  stay: number;
  brief: string;
  status: RunStatus;
  runner_id: string | null;
  fencing_token: number;
  lease_expires_at: string | null;
  /** JSON: a RunResult. */
  result: string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  /** SHA-256 hex of the run's MCP bearer token, or null. */
  mcp_token_hash: string | null;
}

export interface FlowPluginsTable {
  id: string;
  org_id: string;
  name: string;
  /** The person's plain words. */
  request: string;
  code: string;
  /** JSON: the fields the module declared when it was saved. */
  fields: string;
  /** JSON: the hook names the module defined when it was saved. */
  hooks: string;
  enabled: number;
  last_error: string | null;
  trigger_key: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface FlowGatewaysTable {
  id: string;
  org_id: string;
  name: string;
  base_url: string;
  /** JSON: a GatewayAuth. */
  auth: string;
  /** AES-GCM ciphertext (`v1:<iv>:<ciphertext>`, base64), or null. */
  secret: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowDatabase {
  flow_workflows: FlowWorkflowsTable;
  flow_projects: FlowProjectsTable;
  flow_agents: FlowAgentsTable;
  flow_items: FlowItemsTable;
  flow_events: FlowEventsTable;
  flow_runs: FlowRunsTable;
  flow_plugins: FlowPluginsTable;
  flow_gateways: FlowGatewaysTable;
}
