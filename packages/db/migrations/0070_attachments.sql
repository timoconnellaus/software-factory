-- Migration 0070 (work item attachments, ADR 0260): metadata only. The bytes live in the R2 bucket
-- bound as ATTACHMENTS on sf-engine, keyed `<org>/<work item>/<attachment id>` (never by filename).
-- A row exists only while its blob does: `add` writes the blob before the row, `remove` deletes the
-- blob before the row, and the cron sweeps blobs with no row.
CREATE TABLE core_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- The display name, sanitised on the way in. Never used as a storage key or a path.
  filename TEXT NOT NULL,
  -- One of the allow-listed types, checked against the sniffed bytes.
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  blob_key TEXT NOT NULL UNIQUE,
  uploader_type TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX core_attachments_work_item_idx ON core_attachments (work_item_id, created_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 70) WHERE key = 'schema_version';
