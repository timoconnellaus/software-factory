-- Migration 0130 (runners update themselves, ADR 0360): what each runner last reported about its own
-- code: the commit it runs, whether it updates itself, and where its update stands. Null until a
-- runner that reports it heartbeats.
ALTER TABLE core_runners ADD COLUMN version TEXT;
ALTER TABLE core_runners ADD COLUMN auto_update INTEGER;
ALTER TABLE core_runners ADD COLUMN update_state TEXT;
ALTER TABLE core_runners ADD COLUMN update_target TEXT;
ALTER TABLE core_runners ADD COLUMN update_reason TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 130) WHERE key = 'schema_version';
