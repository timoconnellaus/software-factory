-- A run's events and steers move to R2 (sf-archive) 30 days after it ended, and are read back from
-- there (AGENTS.md "Cloudflare cost", rule 3; apps/engine/src/retention.ts, run.live).

-- When the run's events and steers were all archived. The partial index holds only ended runs still
-- to archive, so it empties as they go: the cron's "next run due" is one indexed read.
ALTER TABLE core_runs ADD COLUMN events_archived_at TEXT;
CREATE INDEX core_runs_archive_due_idx ON core_runs (ended_at)
  WHERE ended_at IS NOT NULL AND events_archived_at IS NULL;

-- One row per archived chunk of a run's events (at most 200 stored rows or 1 MB each), kept in D1
-- for good: how run.live finds the one object a page needs. The object is named by the seq range it
-- holds (first_seq to last_seq), written create-only and verified before the batch that records
-- it deletes its rows, so a row is deleted only once an object that provably holds it exists. The
-- steers are one object per run (first_seq -1). About 200 bytes a chunk. Read by run.live on the
-- primary key (run_id, then first_seq or last_seq within the run's few chunks).
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

-- How the run's session ran (ADR 0450), kept on the run so it outlives the events: run.live shows
-- a stream run as a chat even once its `session.started` event is archived. Set by run.events when
-- that event arrives, and by the archiver for older runs when it archives the chunk holding it.
-- Read with the run's row, so no index.
ALTER TABLE core_runs ADD COLUMN session_mode TEXT;

-- The archiver's single-writer lease, one row per run being archived: an overlapping cron tick
-- that can't take it skips the run instead of racing. Every chunk's record-and-delete batch checks
-- the lease and renews it. Retention: the row is deleted when the run is marked archived, or when
-- the tick stops; a tick that dies leaves one row that the next tick takes over once it expires.
-- Read by its primary key only.
CREATE TABLE core_run_archive_leases (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES core_runs (id),
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 362) WHERE key = 'schema_version';
