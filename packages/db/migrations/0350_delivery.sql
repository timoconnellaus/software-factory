-- Migration 0350 (spec 53, ADR 0580): the babysitter's deliverer lands approved merges per repository.
--
-- core_delivery_state: one row per repository queue (key `<project>:<repository>`; an item with no
-- repository is never the babysitter's), the deliverer's bookkeeping (ADR 0586). `rev` and `running_until` let only one pass run at
-- a time (a compare-and-set, as ADR 0511's reconciler does per item), and `rev` is the pass's
-- fencing token: every operation the pass calls is refused once `rev` moved on; `dirty` asks a running pass to
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

-- Who lands a queue entry: its own Workflow (v4–v7, and an incident's auto-merge), or the
-- babysitter's deliverer (v11). How it ended, as sent to the Workflow (`merged`, `conflict`,
-- `failed`, or `withdrawn`: the approval no longer holds, spec 53 PR c), so a lost event can be read
-- back. When GitHub was asked to merge the default branch in.
ALTER TABLE core_merge_queue ADD COLUMN driver TEXT NOT NULL DEFAULT 'workflow'
  CHECK (driver IN ('workflow', 'babysitter'));
ALTER TABLE core_merge_queue ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('merged', 'conflict', 'failed', 'withdrawn'));
ALTER TABLE core_merge_queue ADD COLUMN update_asked_at TEXT;
-- How many times GitHub was asked to update the entry's head: the deliverer stops asking after a
-- few, so a default branch that keeps moving while CI runs can't keep a head updating for ever.
ALTER TABLE core_merge_queue ADD COLUMN updates INTEGER NOT NULL DEFAULT 0;

-- The minute cron's sweep (`deliverDue`) reads only open babysitter entries: a partial index, so it
-- never scans the entries kept after they end.
CREATE INDEX core_merge_queue_babysitter_idx ON core_merge_queue (project_id)
  WHERE status = 'queued' AND driver = 'babysitter';
-- A Workflow reading back how its delivery ended (`mergeQueue.position` when not queued): the item's
-- latest entry.
CREATE INDEX core_merge_queue_item_idx ON core_merge_queue (work_item_id, enqueued_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 350) WHERE key = 'schema_version';
