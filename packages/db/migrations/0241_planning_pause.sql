-- Migration 0241: steering the planner (spec 26 PR B, ADR 0470). A steer may interrupt (Escape,
-- then the factory's fixed line), a planning session may be paused by a person, and a person may
-- tell it to finish alone (bulk-acceptable defaults accepted as they're asked, recorded as such).
ALTER TABLE core_run_steers ADD COLUMN interrupt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_planning_sessions ADD COLUMN paused_at TEXT;
ALTER TABLE core_planning_sessions ADD COLUMN paused_by TEXT;
ALTER TABLE core_planning_sessions ADD COLUMN finish_alone_by TEXT;
ALTER TABLE core_planning_sessions ADD COLUMN finish_alone_at TEXT;
ALTER TABLE core_questions ADD COLUMN accepted_alone INTEGER NOT NULL DEFAULT 0;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 241) WHERE key = 'schema_version';
