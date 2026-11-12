-- Migration 0290 (runner updates without draining, ADR 0520): the RUNNER_COMPAT each runner last
-- reported. Null: it never reported one (code from before ADR 0520), which counts as 1. The claim
-- handler sends no job to a runner below the engine's own RUNNER_COMPAT.
ALTER TABLE core_runners ADD COLUMN compat INTEGER;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 290) WHERE key = 'schema_version';
