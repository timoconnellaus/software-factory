-- Migration 0070 (protect main, ADR 0280): the last verdict on each project's default-branch
-- protection. The factory never changes protection (the App has `administration: read` only); it
-- compares what GitHub reports with the ruleset it generates, and records the result here so drift
-- (a webhook or the daily re-check) can turn Setup red and raise an inbox card.
CREATE TABLE core_project_protection (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  -- 'ok': every expected rule is in force. 'red': something is missing (problems says what).
  -- 'unknown': GitHub couldn't be asked (problems holds the error).
  state TEXT NOT NULL CHECK (state IN ('ok', 'red', 'unknown')),
  problems TEXT NOT NULL DEFAULT '[]',
  warnings TEXT NOT NULL DEFAULT '[]',
  -- What asked: 'setup' (Check now), 'webhook', 'daily'.
  trigger TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  -- When `state` last changed, and when it was last 'ok' (a red after an ok is drift).
  changed_at TEXT NOT NULL,
  last_ok_at TEXT
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 70) WHERE key = 'schema_version';
