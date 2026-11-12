-- Migration 0373: system designs and `.kim/` pulls (spec 22). An artifact may be a `design` (its
-- type: data-model, architecture, data-flow, sequence, state, api), and may come from a file in the
-- repository's `.kim/` folder: its path, and the default branch's head when it was pulled (its
-- content then is kept as revision 0, the base the app compares against and a conflict is checked
-- on). `kind`'s CHECK changes, so the table is rebuilt (as 0261 did): foreign keys are deferred and
-- every row is copied back with its id, so core_planning_artifact_revisions' references hold.
PRAGMA defer_foreign_keys = on;

CREATE TABLE core_planning_artifacts_0373 (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  kind TEXT NOT NULL CHECK (kind IN ('mockup', 'diagram', 'document', 'design')),
  design_type TEXT CHECK (
    design_type IS NULL
    OR design_type IN ('data-model', 'architecture', 'data-flow', 'sequence', 'state', 'api')
  ),
  title TEXT NOT NULL,
  description TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  keep INTEGER NOT NULL DEFAULT 0,
  pulled_path TEXT,
  pulled_base_sha TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO core_planning_artifacts_0373 (
  id, work_item_id, kind, title, description, revision, keep, created_by, created_at, updated_at,
  deleted_at
)
SELECT
  id, work_item_id, kind, title, description, revision, keep, created_by, created_at, updated_at,
  deleted_at
FROM core_planning_artifacts;
DROP TABLE core_planning_artifacts;
ALTER TABLE core_planning_artifacts_0373 RENAME TO core_planning_artifacts;
CREATE INDEX core_planning_artifacts_item_idx ON core_planning_artifacts (work_item_id, created_at);
-- One live artifact per pulled path on an item (design.pull updates it rather than adding another).
CREATE UNIQUE INDEX core_planning_artifacts_pulled_idx
  ON core_planning_artifacts (work_item_id, pulled_path)
  WHERE pulled_path IS NOT NULL AND deleted_at IS NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 373) WHERE key = 'schema_version';
