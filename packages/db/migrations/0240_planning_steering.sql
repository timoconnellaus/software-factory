-- Migration 0240: the planning loop to kim's standard (spec 26, ADR 0470). People may skip a
-- planning question (the agent decides it), and an answer records when it reached the agent
-- (a read receipt, cleared when the answer is revised).
ALTER TABLE core_questions ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_questions ADD COLUMN answer_delivered_at TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 240) WHERE key = 'schema_version';
