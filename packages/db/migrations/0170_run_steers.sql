-- Migration 0170: steers, a person's messages into a live run (spec 31, ADR 0400). `run.steer`
-- queues one; the runner host takes it over the signed channel (`run.takeSteers`), which stamps
-- `delivered_at` (at most once). Only the owner of the run's runner may write one.
CREATE TABLE core_run_steers (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES core_runs (id),
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  author_user_id TEXT NOT NULL,
  -- Sanitised, one line, at most 2,000 characters (`steerText`).
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX core_run_steers_run_idx ON core_run_steers (run_id, created_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 170) WHERE key = 'schema_version';
