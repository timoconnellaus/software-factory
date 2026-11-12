-- Migration 0244: a parked item's "needs info" marker (spec 23, ADR 0474). An item whose request
-- fails the readiness pre-check, or that triage finds not actionable, stays in the Backlog with this
-- JSON: `{ waitingOn, reason, source, missing, questionIds, heading, at }`. Null when not parked.
ALTER TABLE core_work_items ADD COLUMN needs_info TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 244) WHERE key = 'schema_version';
