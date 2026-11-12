-- Migration 0220: a takeover request rides the steer queue (spec 37, ADR 0450). `run.takeover`
-- queues a row of kind `takeover` (empty text); the runner host takes it with the steers and stops
-- the stream session so the runner's owner can resume it in a terminal. Every older row is a
-- message.
ALTER TABLE core_run_steers ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 220) WHERE key = 'schema_version';
