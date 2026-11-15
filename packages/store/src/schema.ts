// The flow_* tables (packages/db/migrations/0430_flow.sql, 0431_flow_plugins.sql, 0433_flow_chat.sql,
// 0434_flow_run_events.sql, 0435_flow_schedules.sql; 0432 adds only indexes), as Kysely sees them.

import type { Generated, Selectable } from "kysely";

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
  /** Events stored in flow_run_events (0 once pruned). */
  event_count: Generated<number>;
  /** The runner's seq of the last event stored: a replayed batch adds nothing. */
  last_event_seq: Generated<number>;
  /** Tool calls the runner reported. Kept after the events are pruned. */
  steps: Generated<number>;
  /** 1 when events beyond the cap were dropped. */
  events_truncated: Generated<number>;
  /** Tokens the runner reported (a stream-json session's turns), or null. */
  tokens: number | null;
  /** Cost the runner reported, or null (no runner reports one yet). */
  cost_usd: number | null;
}

/** A flow_runs row as a read returns it. */
export type FlowRunRow = Selectable<FlowRunsTable>;

export type RunEventKind = "note" | "tool" | "result";

export interface FlowRunEventsTable {
  run_id: string;
  seq: number;
  org_id: string;
  at: string;
  kind: RunEventKind;
  /** JSON: the kind's fields (runEvents.ts). */
  data: string;
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
  flow_run_events: FlowRunEventsTable;
  flow_plugins: FlowPluginsTable;
  flow_gateways: FlowGatewaysTable;
  flow_schedules: FlowSchedulesTable;
}
