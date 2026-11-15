// The flow_* tables (packages/db/migrations/0430_flow.sql), as Kysely sees them.

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
}

export interface FlowEventsTable {
  id: string;
  org_id: string;
  item_id: string;
  seq: number;
  kind: "event" | "effect" | "comment";
  /** JSON: an Actor. */
  actor: string;
  /** JSON: the ItemEvent, the Effect, or `{ text }` for a comment. */
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
}

export interface FlowDatabase {
  flow_workflows: FlowWorkflowsTable;
  flow_projects: FlowProjectsTable;
  flow_agents: FlowAgentsTable;
  flow_items: FlowItemsTable;
  flow_events: FlowEventsTable;
  flow_runs: FlowRunsTable;
}
