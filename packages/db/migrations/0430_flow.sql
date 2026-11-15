-- Migration 0430 (block AX): the new core's tables (ADR 0660, spec 70), written by packages/store.
-- Prefixed flow_, beside the old core_* tables and independent of them: no foreign keys into
-- core_work_items, core_jobs, core_runs or core_projects. `org_id` is a core_organization id.
-- Timestamps are ISO 8601 text, as in the rest of the schema.

-- An org's workflows. `definition` is the Workflow from packages/flow, as JSON.
-- Retention: kept while the org uses it (a handful per org); nothing deletes one yet.
CREATE TABLE flow_workflows (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- listWorkflows: `WHERE org_id = ? ORDER BY name`.
CREATE INDEX flow_workflows_org_idx ON flow_workflows (org_id, name);

-- An org's projects. `key` prefixes item numbers ("ACM-12"); `next_number` is the next one.
-- Retention: kept while the org uses it (a handful per org); nothing deletes one yet.
CREATE TABLE flow_projects (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES flow_workflows (id),
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
-- listProjects: `WHERE org_id = ? ORDER BY name`.
CREATE INDEX flow_projects_org_idx ON flow_projects (org_id, name);

-- An org's agents: who a status's owner { kind: "agent", agentId } names.
-- Retention: kept while the org uses it (a handful per org); nothing deletes one yet.
CREATE TABLE flow_agents (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- listAgents: `WHERE org_id = ? ORDER BY name`.
CREATE INDEX flow_agents_org_idx ON flow_agents (org_id, name);

-- Items: the kernel's ItemState (status_id, waiting_on + waiting_ref, error, stay) plus the item's
-- own fields. `waiting_ref` is the agent id (run) or user id (person) it waits on, else null.
-- Retention: kept as the org's record of its work; nothing prunes items yet.
CREATE TABLE flow_items (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES flow_projects (id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status_id TEXT NOT NULL,
  waiting_on TEXT NOT NULL CHECK (waiting_on IN ('run', 'person', 'decision', 'nothing')),
  waiting_ref TEXT,
  error TEXT,
  stay INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);
-- board: `WHERE project_id = ? ORDER BY status_id, number`.
CREATE INDEX flow_items_board_idx ON flow_items (project_id, status_id, number);
-- inbox: `WHERE org_id = ? AND waiting_on = 'person' AND waiting_ref = ? ORDER BY updated_at`, and
-- `WHERE org_id = ? AND waiting_on = 'decision' AND waiting_ref IS NULL ORDER BY updated_at`.
CREATE INDEX flow_items_inbox_idx ON flow_items (org_id, waiting_on, waiting_ref, updated_at);

-- An item's timeline: each event applied (`event`), each effect carried out (`effect`), and each
-- comment (`comment`), numbered per item from 1. `actor` and `data` are JSON.
-- Retention: kept with its item, as the item's record; nothing prunes it yet.
CREATE TABLE flow_events (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES flow_items (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'effect', 'comment')),
  actor TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Also the timeline's index: `WHERE item_id = ? ORDER BY seq`, and applyEvent's
  -- `SELECT MAX(seq) FROM flow_events WHERE item_id = ?`. Two writers appending the same seq
  -- collide here, so only one of them advances the item.
  UNIQUE (item_id, seq)
);

-- An agent's run on an item, for one stay in one status. `fencing_token` goes up on each claim.
-- Retention: kept with its item, as the item's record; nothing prunes runs yet.
CREATE TABLE flow_runs (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES flow_items (id),
  agent_id TEXT NOT NULL,
  status_id TEXT NOT NULL,
  stay INTEGER NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  runner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT
);
-- claimRun: `WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`.
CREATE INDEX flow_runs_queue_idx ON flow_runs (created_at, id) WHERE status = 'queued';
-- expireRuns: `WHERE status = 'claimed' AND lease_expires_at < ? ORDER BY lease_expires_at LIMIT ?`.
CREATE INDEX flow_runs_lease_idx ON flow_runs (lease_expires_at) WHERE status = 'claimed';
-- run.cancel: `UPDATE flow_runs ... WHERE item_id = ? AND stay = ? AND status IN (...)`, and
-- itemRuns: `WHERE item_id = ? ORDER BY stay`.
CREATE INDEX flow_runs_item_idx ON flow_runs (item_id, stay);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 430) WHERE key = 'schema_version';
