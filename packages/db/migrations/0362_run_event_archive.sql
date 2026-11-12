-- A run's events and steers move to R2 (sf-archive) 30 days after it ended, and are read back from
-- there (AGENTS.md "Cloudflare cost", rule 3; apps/engine/src/retention.ts, run.live).

-- When the run's events and steers were all archived. The partial index holds only ended runs still
-- to archive, so it empties as they go: the cron's "next run due" is one indexed read.
ALTER TABLE core_runs ADD COLUMN events_archived_at TEXT;
CREATE INDEX core_runs_archive_due_idx ON core_runs (ended_at)
  WHERE ended_at IS NOT NULL AND events_archived_at IS NULL;

-- One row per archived chunk of a run's events (at most 200 stored rows or ~1 MB each), kept in D1
-- for good: how run.live finds the one object a page needs. The steers are one object per run
-- (first_seq -1). About 200 bytes a chunk.
CREATE TABLE core_run_archive_chunks (
  run_id TEXT NOT NULL REFERENCES core_runs (id),
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  rows INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  PRIMARY KEY (run_id, first_seq)
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 362) WHERE key = 'schema_version';
