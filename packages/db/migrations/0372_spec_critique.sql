-- Migration 0372: the spec critic's notes on a plan version (spec 23 part C). JSON
-- `{ status: "done" | "timed_out" | "failed", notes: string[], summary, at }`; null until the critic has run.
ALTER TABLE core_specs ADD COLUMN critique TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 372) WHERE key = 'schema_version';
