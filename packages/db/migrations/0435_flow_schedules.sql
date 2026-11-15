-- Migration 0435 (block AX): schedules for the new core (spec 70, the Auto screen). A schedule
-- creates an item in a project on a clock ("every day at 02:00, create 'Nightly triage' in Customer
-- feedback"); the item then goes through its project's workflow like any other. Written by
-- packages/store (schedules.ts), fired by the engine's minute cron.

-- `every` is 'hour' | 'day' | 'weekday' | 'week'. `at_hour` is null for 'hour'; `on_day` (0 Sunday
-- to 6 Saturday) is set only for 'week'. Times are wall-clock in `time_zone` (an IANA name);
-- `next_at` is when it next fires, as ISO text in UTC, null while it is off. `last_item_id` is the
-- item it last made; `last_error` why its last firing failed (cleared by the next that works).
-- Retention: state, kept until deleted (a handful per org); flow.schedule.delete removes one.
CREATE TABLE flow_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  every TEXT NOT NULL CHECK (every IN ('hour', 'day', 'weekday', 'week')),
  at_minute INTEGER NOT NULL CHECK (at_minute BETWEEN 0 AND 59),
  at_hour INTEGER CHECK (at_hour BETWEEN 0 AND 23),
  on_day INTEGER CHECK (on_day BETWEEN 0 AND 6),
  time_zone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_at TEXT,
  last_at TEXT,
  last_item_id TEXT,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The cron's due query (dueSchedules): `WHERE enabled = 1 AND next_at <= ? ORDER BY next_at
-- LIMIT 20`. Partial, so it holds only schedules that are on.
CREATE INDEX flow_schedules_due_idx ON flow_schedules (next_at) WHERE enabled = 1;

-- flow.schedule.list (listSchedules): `WHERE s.org_id = ? ORDER BY s.name`, and every write's
-- `WHERE id = ? AND org_id = ?` is by primary key.
CREATE INDEX flow_schedules_org_idx ON flow_schedules (org_id, name);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 435) WHERE key = 'schema_version';
