-- The audit archive (ADR 0590, decided 2026-11-12; as built in ADR 0591). Routine machine rows of
-- core_audit older than 90 days move to R2 (sf-archive) as a hash chain, one day at a time, and are
-- then deleted from D1. Decisions, refusals, approvals, gates, config changes and everything a person
-- did stay in D1 forever. Nothing is added to the hot write path: no index, no counter, no hash read
-- before an audited call's batch. The chain is built by the archiver (apps/engine/src/audit-archive.ts),
-- the one writer that touches old rows.
--
-- A **machine row** (the only rows that can ever be deleted) is a core_audit row that is all of:
-- - written by a runner, the scheduler, an intake connector, or the foreman (actor_type 'agent' with
--   actor_id 'foreman'), never a person (`human`), another agent or `self-improve`;
-- - allowed and successful (`decision = 'allow'`, `outcome = 'ok'`): never a refusal, a failure, a
--   gate held for review or denied;
-- - not tied to a gate or an approval (`pending_action_id` and `approval_id` both NULL);
-- - one of the routine operations listed in the trigger below (and in AUDIT_ARCHIVE_OPERATIONS in
--   packages/core/src/audit-chain.ts, which a test keeps equal to this list): leases, heartbeats,
--   claims, steers, run events, artifacts, hand-backs, stage moves, merge-queue moves short of
--   merging, a branch's first push, deliveries of news and the intake's observations. Never what
--   issues a credential (a job token, a device login's runner key or CLI token, a sign-in), never
--   the record of what reached main (`mergeQueue.merging`, `branch.advance`, a merge), no PR, no
--   spec, no triage, no question, no planning content, no gate, no incident, no config or policy
--   change, no work item created or released.
-- Changing that list is a migration, so it is reviewed by a person like any other policy change.

-- One row per archived UTC day, kept in D1 for good: the day's root (the hash of its last machine
-- row, or the previous day's root when it had none) and the root it chained from. Written once,
-- when the day's last chunk is in. Read by the archiver (the last day archived), the timeline and
-- audit.verify by its primary key (`day`).
CREATE TABLE core_audit_archives (
  day TEXT PRIMARY KEY NOT NULL,
  chunks INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  root TEXT NOT NULL,
  prev_root TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

-- One row per archived object (a chunk of a day: at most 1,000 rows or 1 MB), kept in D1 for good:
-- the (at, id) range it holds, the chain hash it started from and its last row's hash. The object
-- is named by its day, seq and range and written create-only; its record and the delete of its rows
-- are one batch. Read by its primary key: the archiver (the day's last chunk), the delete trigger
-- (the chunks of the row's day), the timeline and audit.verify (a day's chunks, or one by seq).
CREATE TABLE core_audit_archive_chunks (
  day TEXT NOT NULL,
  seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  first_at TEXT NOT NULL,
  first_id TEXT NOT NULL,
  last_at TEXT NOT NULL,
  last_id TEXT NOT NULL,
  rows INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  last_hash TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  PRIMARY KEY (day, seq)
);

-- Which archived chunks hold a work item's rows, and how many: how workItem.timeline finds the
-- objects to read for one item without reading every day. One row per (item, chunk), written in
-- the chunk's batch, kept for good (a few per item). Read by its primary key prefix (work_item_id).
CREATE TABLE core_audit_archive_items (
  work_item_id TEXT NOT NULL,
  day TEXT NOT NULL,
  seq INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  PRIMARY KEY (work_item_id, day, seq)
);

-- The archiver's single-writer lease, one row per day being archived: an overlapping tick that
-- can't take it skips the day instead of racing. Every chunk's batch checks the lease and renews
-- it. Retention: deleted when the day is recorded or the tick stops; a tick that dies leaves one
-- row that the next tick takes over once it expires. Read by its primary key only.
CREATE TABLE core_audit_archive_leases (
  day TEXT PRIMARY KEY NOT NULL,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- The journal stays append-only, except for exactly this delete: a machine row (above) at least 90
-- days old whose (at, id) falls inside an archived chunk's range for its day. UPDATE stays refused.
-- The trigger checks that a chunk's range covers the row, not that the row is in the object: the
-- archiver's batch deletes exactly the ids it wrote to the object, in the batch that records it
-- (ADR 0591). Checking membership in SQL would cost 2 to 4 more rows written per archived row.
-- Created before the old trigger is dropped, so there is no moment with neither.
CREATE TRIGGER core_audit_delete_archived_only BEFORE DELETE ON core_audit
WHEN NOT (
  OLD.decision = 'allow'
  AND OLD.outcome = 'ok'
  AND OLD.pending_action_id IS NULL
  AND OLD.approval_id IS NULL
  AND (OLD.actor_type IN ('runner', 'scheduler', 'intake')
       OR (OLD.actor_type = 'agent' AND OLD.actor_id = 'foreman'))
  AND OLD.operation IN (
    'runner.heartbeat', 'job.claim', 'job.enqueue',
    'run.takeSteers', 'run.reportEvents', 'run.addArtifact', 'run.handBack', 'run.release',
    'run.expire',
    'lease.claim', 'lease.heartbeat', 'lease.release',
    'planning.wait', 'planning.news', 'planning.yield', 'planning.requestYield',
    'branch.ensure',
    'workItem.enterStage', 'workItem.awaitHead', 'workItem.awaitQuestions',
    'mergeQueue.enter', 'mergeQueue.leave', 'mergeQueue.update', 'mergeQueue.hold', 'queue.pull',
    'connector.receive', 'push.observe', 'main.observe', 'verify.refresh'
  )
  AND OLD.at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
  AND EXISTS (
    SELECT 1 FROM core_audit_archive_chunks c
    WHERE c.day = substr(OLD.at, 1, 10)
      AND (OLD.at > c.first_at OR (OLD.at = c.first_at AND OLD.id >= c.first_id))
      AND (OLD.at < c.last_at OR (OLD.at = c.last_at AND OLD.id <= c.last_id))
  )
)
BEGIN SELECT RAISE(ABORT, 'core_audit is append-only: only archived machine rows may be deleted'); END;
DROP TRIGGER IF EXISTS core_audit_no_delete;

-- INSERT OR REPLACE would delete a row without the delete trigger firing (recursive triggers are
-- off), so a person's row could be replaced by a machine row and then archived away. Refused: an
-- insert whose id or idempotency key is already there aborts, with the message a UNIQUE conflict
-- has (invoke() reads a conflict on the idempotency key from it). Two index lookups per audit
-- insert, no write.
CREATE TRIGGER core_audit_no_replace BEFORE INSERT ON core_audit
WHEN EXISTS (SELECT 1 FROM core_audit WHERE id = NEW.id)
  OR (NEW.idempotency_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM core_audit WHERE idempotency_key = NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: core_audit (append-only: no replace)'); END;

-- The archive's records are written once: a day, a chunk and its work-item index rows are never
-- changed or deleted, so the chain's head can only advance by a new day.
CREATE TRIGGER core_audit_archives_no_update BEFORE UPDATE ON core_audit_archives
BEGIN SELECT RAISE(ABORT, 'core_audit_archives is append-only'); END;
CREATE TRIGGER core_audit_archives_no_delete BEFORE DELETE ON core_audit_archives
BEGIN SELECT RAISE(ABORT, 'core_audit_archives is append-only'); END;
CREATE TRIGGER core_audit_archive_chunks_no_update BEFORE UPDATE ON core_audit_archive_chunks
BEGIN SELECT RAISE(ABORT, 'core_audit_archive_chunks is append-only'); END;
CREATE TRIGGER core_audit_archive_chunks_no_delete BEFORE DELETE ON core_audit_archive_chunks
BEGIN SELECT RAISE(ABORT, 'core_audit_archive_chunks is append-only'); END;
CREATE TRIGGER core_audit_archive_items_no_update BEFORE UPDATE ON core_audit_archive_items
BEGIN SELECT RAISE(ABORT, 'core_audit_archive_items is append-only'); END;
CREATE TRIGGER core_audit_archive_items_no_delete BEFORE DELETE ON core_audit_archive_items
BEGIN SELECT RAISE(ABORT, 'core_audit_archive_items is append-only'); END;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 366) WHERE key = 'schema_version';
