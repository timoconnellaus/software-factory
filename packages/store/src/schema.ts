// The flow_* tables (packages/db/migrations/0430_flow.sql, 0431_flow_plugins.sql, 0433_flow_chat.sql,
// 0435_flow_schedules.sql, 0436_flow_repositories.sql; 0432 adds only indexes), as Kysely sees them.

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
  /** The project's GitHub repository (migration 0436): all four set, or all null. */
  repo_owner: string | null;
  repo_name: string | null;
  repo_default_branch: string | null;
  /** GitHub's id of the org's App installation that reaches the repository. */
  repo_installation_id: string | null;
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
  /** `factory/flow/<key>-<number>`, set when its first run with a repository is claimed (0436). */
  branch: string | null;
  /** The branch's head as the last run that ended `done` pushed it. */
  head_sha: string | null;
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
  /** A run belongs to an item or to a chat (migration 0433): exactly one of these is set. */
  item_id: string | null;
  chat_id: string | null;
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
  /** The branch the run worked on, and the head it handed back (0436); null without a repository. */
  branch: string | null;
  head_sha: string | null;
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

/** A schedule (migration 0435): an item made in a project on a clock. */
export interface FlowSchedulesTable {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  /** The item's title. */
  title: string;
  /** The item's body. */
  body: string;
  every: "hour" | "day" | "weekday" | "week";
  at_minute: number;
  at_hour: number | null;
  on_day: number | null;
  time_zone: string;
  enabled: number;
  /** ISO, UTC; null while it is off. */
  next_at: string | null;
  last_at: string | null;
  last_item_id: string | null;
  last_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface FlowChatsTable {
  id: string;
  org_id: string;
  agent_id: string;
  /** The first message, cut to 80 characters. */
  title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type ChatRole = "person" | "agent" | "did";

export interface FlowChatMessagesTable {
  id: string;
  chat_id: string;
  org_id: string;
  seq: number;
  role: ChatRole;
  text: string;
  /** JSON: a `did` row's { kind, id, name? }, or an agent message's { failed: true }; else null. */
  data: string | null;
  run_id: string | null;
  created_at: string;
}

export interface FlowDatabase {
  flow_chats: FlowChatsTable;
  flow_chat_messages: FlowChatMessagesTable;
  flow_workflows: FlowWorkflowsTable;
  flow_projects: FlowProjectsTable;
  flow_agents: FlowAgentsTable;
  flow_items: FlowItemsTable;
  flow_events: FlowEventsTable;
  flow_runs: FlowRunsTable;
  flow_plugins: FlowPluginsTable;
  flow_gateways: FlowGatewaysTable;
  flow_schedules: FlowSchedulesTable;
}
