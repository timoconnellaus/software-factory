-- Spec 52 (g2), ADR 0514 as amended: autopilot runs.
--
-- A run is a work item the factory starts on its own. Its kind has ONE source of truth, the
-- virtual generated column `item_kind`: 'autopilot' when the item is an autopilot run, else the
-- stored `kind`. No rebuild of core_work_items for one more kind (its CHECK can't be altered, and a
-- rebuild copying a column list would drop columns other branches add): every read that branches or
-- filters on an item's kind reads `item_kind` (a test fails on a raw `kind` comparison).
ALTER TABLE core_work_items ADD COLUMN autopilot_run_id TEXT;
ALTER TABLE core_work_items ADD COLUMN item_kind TEXT
  GENERATED ALWAYS AS (CASE WHEN autopilot_run_id IS NOT NULL THEN 'autopilot' ELSE kind END) VIRTUAL;

-- Each firing of an autopilot: what fired it (its dedupe key: one occurrence fires once), the org
-- config version it ran under, the work item that is the run, and what it produced.
-- Retention: 90 days, pruned in batches by the hourly cron (pruneAutopilotRuns); a run's work item
-- keeps its own history.
CREATE TABLE core_autopilot_runs (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id),
  autopilot_id TEXT NOT NULL,
  org_config_version INTEGER NOT NULL,
  -- 'schedule' | 'event' | 'manual'
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'event', 'manual')),
  -- `schedule:<id>:<minute>`, `ci:<repo>:<sha>`, `manual:<run id>`…
  dedupe_key TEXT NOT NULL,
  project_id TEXT REFERENCES core_projects (id),
  work_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'skipped')),
  -- Why it was skipped or how it ended, for the run history.
  reason TEXT,
  -- JSON: what it filed, labelled, digested or proposed ({kind, id}[]), at most its maxOutputs.
  outputs TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (org_id, dedupe_key)
);
-- Read by: autopilot.get's run history (org_id, autopilot_id, newest first, LIMIT 20) and the daily
-- cap (the same autopilot's runs since midnight UTC, LIMIT runsPerDay + 1).
CREATE INDEX core_autopilot_runs_autopilot_idx
  ON core_autopilot_runs (org_id, autopilot_id, created_at);
-- Read by: the retention prune (created_at < cutoff, LIMIT).
CREATE INDEX core_autopilot_runs_created_idx ON core_autopilot_runs (created_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 284) WHERE key = 'schema_version';
