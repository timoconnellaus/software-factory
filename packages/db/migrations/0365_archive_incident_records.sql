-- A lost archive object is an incident for a person, recorded and nothing more: no work item, so
-- nothing can release it into the incident workflow (whose fixes can auto-merge). The record is the
-- core_incidents row (kind `archive_missing`, fix_work_item_id NULL), and a person closes it with
-- incident.resolve. Kept in D1 for good: one row per run whose archive lost an object (rare).

-- When, by whom and how a person resolved the incident (incident.resolve). NULL while open.
ALTER TABLE core_incidents ADD COLUMN resolved_at TEXT;
ALTER TABLE core_incidents ADD COLUMN resolved_by TEXT;
ALTER TABLE core_incidents ADD COLUMN resolution TEXT;

-- Read by incident.listArchiveMissing (the desktop's Factory > Checks and incidents page, when it
-- is opened, never polled): an org's open archive incidents, newest first
-- (`WHERE org_id = ? AND kind = 'archive_missing' AND resolved_at IS NULL ORDER BY created_at DESC
-- LIMIT ?`). Partial, so it holds only the open ones and stays near empty.
CREATE INDEX core_incidents_open_archive_idx ON core_incidents (org_id, created_at)
  WHERE kind = 'archive_missing' AND resolved_at IS NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 365) WHERE key = 'schema_version';
