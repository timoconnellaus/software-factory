-- Migration 0243: planning visuals (spec 21, ADR 0472). The planner's mockups, documents and
-- diagrams, each revision kept with its content (at most 1.9 MB) and the controls it declares;
-- questions linked to them (an artifact on screen, options as cards, answers bound to controls);
-- comments pinned to a spot in one.
CREATE TABLE core_planning_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  kind TEXT NOT NULL CHECK (kind IN ('mockup', 'diagram', 'document')),
  title TEXT NOT NULL,
  description TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  -- Saved to the repo's .kim/ when the plan is approved (spec 22); interview-only otherwise.
  keep INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX core_planning_artifacts_item_idx ON core_planning_artifacts (work_item_id, created_at);

CREATE TABLE core_planning_artifact_revisions (
  artifact_id TEXT NOT NULL REFERENCES core_planning_artifacts (id),
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- JSON: the controls the content declares (`--var`, `@attr`, `#slot`).
  controls TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision)
);

ALTER TABLE core_questions ADD COLUMN artifact_id TEXT;
-- JSON: option label → artifact id (options shown as cards).
ALTER TABLE core_questions ADD COLUMN option_artifacts TEXT;
-- JSON: option label → { control → value } in the artifact named by artifact_id.
ALTER TABLE core_questions ADD COLUMN option_values TEXT;
-- The one control a number (a variable) or text (a slot) answer sets, and a number's range.
ALTER TABLE core_questions ADD COLUMN control TEXT;
ALTER TABLE core_questions ADD COLUMN unit TEXT;
ALTER TABLE core_questions ADD COLUMN min REAL;
ALTER TABLE core_questions ADD COLUMN max REAL;
ALTER TABLE core_questions ADD COLUMN step REAL;

-- JSON: a comment pinned to a spot in an artifact.
ALTER TABLE core_planning_messages ADD COLUMN pin TEXT;
-- The artifact the planner put on everyone's screen last.
ALTER TABLE core_planning_sessions ADD COLUMN shown_artifact_id TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 243) WHERE key = 'schema_version';
