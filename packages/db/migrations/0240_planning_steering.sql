-- Migration 0240: the planning loop to kim's standard (spec 26, ADR 0470). People may skip a
-- planning question (the agent decides it), and an answer records when it reached the agent
-- (a read receipt, cleared when the answer is revised).
ALTER TABLE core_questions ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_questions ADD COLUMN answer_delivered_at TEXT;
-- A steer on a planning run is in the chat; it is delivered when the runner host takes the steer.
ALTER TABLE core_planning_messages ADD COLUMN steer_id TEXT;
-- The last "away" notice (a question or a reply), so they go once per burst, as kim's do.
ALTER TABLE core_planning_sessions ADD COLUMN notified_at TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 240) WHERE key = 'schema_version';
