-- The adjudicator (ADR 0374, spec 09 M4): for each open spec gate or workflow gate step of a kind a
-- project enables, a read-only review job records the verdict it would give. In shadow mode that's
-- all; active, and only once it has earned it, it approves (never rejects).
CREATE TABLE core_adjudications (
  id TEXT PRIMARY KEY NOT NULL,
  pending_action_id TEXT NOT NULL UNIQUE REFERENCES core_pending_actions (id),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  -- spec | step
  kind TEXT NOT NULL,
  -- shadow | active: the mode when it was asked
  mode TEXT NOT NULL,
  job_id TEXT NOT NULL,
  -- approve | defer; null until its job hands back
  verdict TEXT,
  reason TEXT,
  -- 1 when it approved the gate itself (active mode)
  acted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX core_adjudications_project_idx ON core_adjudications (project_id, kind, created_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 143) WHERE key = 'schema_version';
