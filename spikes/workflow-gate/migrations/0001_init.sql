-- Spike schema: work items, pending actions (gates), the audit journal, the outbox and settings.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  size TEXT,
  stage TEXT NOT NULL DEFAULT 'intake',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting', 'done', 'rejected', 'stopped', 'expired')),
  workflow_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, external_id)
);

-- A `review` gate decision becomes a pending action. Approving it sends `approval-<id>` to the
-- work item's Workflow, which re-runs the operation with the approval.
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  input TEXT NOT NULL,
  work_item_id TEXT,
  workflow_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT
);
CREATE INDEX pending_actions_status_idx ON pending_actions (status, created_at);

-- The audit journal: one row per write, refusal and failure. Append-only. Metrics are views over it.
CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  decision TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('ok', 'review', 'denied', 'forbidden', 'killed', 'failed')),
  reason TEXT,
  input TEXT NOT NULL,
  result TEXT,
  work_item_id TEXT,
  pending_action_id TEXT,
  approval_id TEXT,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX audit_work_item_idx ON audit (work_item_id, at);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

-- Written in the same batch as the change; delivered after commit, retried by the cron.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_error TEXT
);
