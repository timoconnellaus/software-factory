-- The factory improves its own practice (ADR 0373, spec 09 M3). A trial applies a candidate config
-- version (a row in core_project_policies the project doesn't point at) to the next N work items,
-- then the improver promotes it (the project points at it) or disables it, with the evidence.
CREATE TABLE core_config_trials (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  -- The version it was drafted against, and the candidate (`v<N>` keys in core_project_policies).
  base_sha TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  -- tier | instructions | …: what kind of practice change it is.
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  -- JSON: the signals that led to it.
  evidence TEXT NOT NULL DEFAULT '{}',
  target_items INTEGER NOT NULL,
  -- running | promoted | disabled
  status TEXT NOT NULL DEFAULT 'running',
  -- JSON: the comparison that decided it.
  outcome TEXT,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX core_config_trials_project_idx ON core_config_trials (project_id, status);

-- The trial a work item ran under (it runs on the trial's candidate version).
ALTER TABLE core_work_items ADD COLUMN trial_id TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 142) WHERE key = 'schema_version';
