-- Migration 0371: the readiness pre-check's duplicate lookup (spec 23): an open item of the same
-- project with the same title (and source), one row at most. Without it the lookup would scan the
-- project's items.
CREATE INDEX IF NOT EXISTS core_work_items_project_title_idx ON core_work_items (project_id, title);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 371) WHERE key = 'schema_version';
