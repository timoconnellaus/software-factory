-- Migration 0040 (V1 step 4): the GitHub connector's delivery log, the `factory/verify` check run
-- per head SHA, and the incident fields the improvement loop needs (root-cause class, proposed fix).

-- Every webhook delivery seen, by provider + delivery id (ADR 0010). A redelivery finds its row and
-- is a no-op. `outcome` says what the connector did with it.
CREATE TABLE core_connector_events (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT,
  repo TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, delivery_id)
);
CREATE INDEX core_connector_events_at_idx ON core_connector_events (received_at);

-- The `factory/verify` check run the App posted for one head SHA of a project's repo (ADR 0037).
-- One row per (project, SHA): a new push is a new SHA, so it starts without a passing check.
CREATE TABLE core_verify_checks (
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  -- NULL for a PR the factory didn't open (it fails until attached to a work item, spec 04 crit. 3).
  work_item_id TEXT,
  pr_number INTEGER,
  github_check_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed')),
  conclusion TEXT CHECK (conclusion IN ('success', 'failure', 'neutral', 'cancelled', 'action_required')),
  title TEXT NOT NULL,
  review_packet_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, head_sha)
);
CREATE INDEX core_verify_checks_item_idx ON core_verify_checks (work_item_id);

-- Incidents: why it happened (a root-cause class) and what to change in `.factory/`.
ALTER TABLE core_incidents ADD COLUMN root_cause TEXT;
ALTER TABLE core_incidents ADD COLUMN proposed_fix TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 40) WHERE key = 'schema_version';
