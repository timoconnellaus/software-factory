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
  released_by TEXT,
  -- What the edit asks the planner to keep: `{ blocks: [{section, text}], gone: [{section, text,
  -- max}] }`, by section and count (review of #85, round 2).
  footprint TEXT NOT NULL DEFAULT '{"blocks":[],"gone":[]}'
);
CREATE INDEX core_spec_edits_item_idx ON core_spec_edits (work_item_id, created_at);

-- `{ specId, lineStart, lineEnd, quote }`: a comment on plan lines.
ALTER TABLE core_planning_messages ADD COLUMN anchor TEXT;
-- The edit an answer was recorded from (`question.answerFromEdit`).
ALTER TABLE core_questions ADD COLUMN answered_via_edit TEXT;

-- One version number per plan is core_specs' own UNIQUE (work_item_id, version), since 0020: no
-- duplicate can exist, so racing writes fail on it (review of #85, round 2).

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 242) WHERE key = 'schema_version';
