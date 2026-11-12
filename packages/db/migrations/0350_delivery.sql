-- Migration 0350 (spec 53, ADR 0580): the babysitter's deliverer lands approved merges per repository.
--
-- core_delivery_state: one row per repository queue (the project, and the repository when the
-- item records one), the deliverer's bookkeeping. `rev` and `running_until` let only one pass run at
-- a time (a compare-and-set, as ADR 0511's reconciler does per item); `dirty` asks a running pass to
-- go round again because something changed meanwhile; `next_check_at` is when the minute cron looks
-- again without an event.
CREATE TABLE core_delivery_state (
  key TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  repository_id TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  running_until TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX core_delivery_state_due_idx ON core_delivery_state (next_check_at);

-- Who lands a queue entry: its own Workflow (v4–v7, and an incident's auto-merge), or the
-- babysitter's deliverer (v11). How it ended, as sent to the Workflow (`merged`, `conflict`,
-- `failed`), so a lost event can be read back. When GitHub was asked to merge the default branch in.
ALTER TABLE core_merge_queue ADD COLUMN driver TEXT NOT NULL DEFAULT 'workflow'
  CHECK (driver IN ('workflow', 'babysitter'));
ALTER TABLE core_merge_queue ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('merged', 'conflict', 'failed'));
ALTER TABLE core_merge_queue ADD COLUMN update_asked_at TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 350) WHERE key = 'schema_version';
