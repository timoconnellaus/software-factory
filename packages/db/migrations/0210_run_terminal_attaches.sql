-- Migration 0210: web terminal attaches (spec 35, ADR 0440). `run.terminal.attach` records one each
-- time a person opens a run's web terminal: who, when, and whether they could type (`type`, the
-- runner's owner) or only watch (`watch`). The job's relay stamps `closed_at` through
-- `run.terminal.detach` when the socket goes.
CREATE TABLE core_run_terminal_attaches (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES core_runs (id),
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('type', 'watch')),
  opened_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX core_run_terminal_attaches_run_idx ON core_run_terminal_attaches (run_id, opened_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 210) WHERE key = 'schema_version';
