-- Migration 0242: people edit the plan and comment on its parts (spec 27, ADR 0471). Each edit a
-- person makes to the plan's source lines, which the planner must keep word for word; a comment's
-- anchor on a chat message; and an answer the planner recorded from a person's edit.
CREATE TABLE core_spec_edits (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  -- The version the edit made, and the one it was made on.
  spec_id TEXT NOT NULL,
  base_spec_id TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- A later edit by a person that covers this one retires it.
  replaced_by TEXT,
  -- A person let the planner reword it (spec.releaseEdit).
  released_at TEXT,
  released_by TEXT
);
CREATE INDEX core_spec_edits_item_idx ON core_spec_edits (work_item_id, created_at);

-- `{ specId, lineStart, lineEnd, quote }`: a comment on plan lines.
ALTER TABLE core_planning_messages ADD COLUMN anchor TEXT;
-- The edit an answer was recorded from (`question.answerFromEdit`).
ALTER TABLE core_questions ADD COLUMN answered_via_edit TEXT;

-- One version number per plan: racing writes can't both take it (review of #85).
CREATE UNIQUE INDEX IF NOT EXISTS core_specs_item_version_idx ON core_specs (work_item_id, version);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 242) WHERE key = 'schema_version';
