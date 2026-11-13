-- Migration 0390 (spec 53 part d, ADRs 0583 and 0620): the `babysit` job kind, the delivery fence and the
-- known-flake list. Block AT: it rebuilds core_jobs, so it must come after 0363 (which added
-- `shaping` to it); block AP's numbers (0350–0359) sort before that.

-- core_jobs is rebuilt once more, and for the last time: without the CHECK on `stage`. SQLite
-- can't alter a CHECK, so every new stage meant a rebuild (0120 for `planning`); from here the
-- stage is validated in code (runner-contract's `JOB_STAGES`, the zod schema of every operation
-- that writes a job), and a new stage needs no migration. Same columns, same four indexes.
--
-- It needs 0363 (core_jobs.shaping). Every database that reaches here has it (block AQ is on main
-- and deployed); one that doesn't fails on the next statement ("no such column: shaping") instead
-- of copying a column that isn't there.
CREATE TABLE core_jobs_0390_needs_0363_shaping AS SELECT shaping FROM core_jobs LIMIT 0;
DROP TABLE core_jobs_0390_needs_0363_shaping;

-- Orphans first: foreign-key checks are deferred to the commit, so one job whose work item is
-- gone would fail the whole migration there. Such a job can never run (job.claim joins its item)
-- and nothing reads it; a job a run still references is kept, so no run loses its job. Run
-- `PRAGMA foreign_key_check` against production before deploying (see PR #158).
DELETE FROM core_jobs
WHERE work_item_id NOT IN (SELECT id FROM core_work_items)
  AND id NOT IN (SELECT job_id FROM core_runs);

-- The rows are held in a plain copy, core_jobs is dropped and created again under its own name
-- (core_runs references it by name), and the rows go back in, as 0120 did. Rows written: about
-- twice the job count, plus four index entries per job.
PRAGMA defer_foreign_keys = on;

CREATE TABLE core_jobs_0390_copy AS SELECT * FROM core_jobs;
DROP TABLE core_jobs;

CREATE TABLE core_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  -- Validated in code (runner-contract `JOB_STAGES`): no CHECK, so a new stage needs no rebuild.
  stage TEXT NOT NULL,
  -- The model role the harness runs as (ADR 0018).
  role TEXT NOT NULL,
  harness TEXT NOT NULL DEFAULT 'claude-code',
  requires TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL,
  -- Extra stage input (send-back notes, criteria, the planning session, a babysit job's reason and
  -- its delivery fence); small JSON.
  context TEXT NOT NULL DEFAULT '{}',
  session_timeout_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  -- Why a queued job is not being placed, e.g. 'waiting on review' (WIP limit).
  wait_reason TEXT,
  runner_id TEXT,
  claim_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  -- ADR 0301: heavy (build, verify) or light (triage, spec, planning, babysit).
  pool TEXT NOT NULL DEFAULT 'heavy' CHECK (pool IN ('heavy', 'light')),
  -- Only this runner may claim it (a planning session resumes where it ran, ADR 0300).
  pinned_runner_id TEXT,
  planning_session_id TEXT,
  -- 0141 (ADR 0372): standard | light; null is standard.
  tier TEXT,
  -- 0363 (ADR 0493): queued for an item still shaping.
  shaping INTEGER NOT NULL DEFAULT 0
);
INSERT INTO core_jobs (
  id, work_item_id, project_id, org_id, stage, role, harness, requires, prompt, context,
  session_timeout_ms, status, wait_reason, runner_id, claim_id, run_id, created_at, claimed_at,
  finished_at, pool, pinned_runner_id, planning_session_id, tier, shaping
)
SELECT
  id, work_item_id, project_id, org_id, stage, role, harness, requires, prompt, context,
  session_timeout_ms, status, wait_reason, runner_id, claim_id, run_id, created_at, claimed_at,
  finished_at, pool, pinned_runner_id, planning_session_id, tier, shaping
FROM core_jobs_0390_copy;
DROP TABLE core_jobs_0390_copy;
-- The same indexes as before the rebuild (0120, 0363), each still read by the query named there.
CREATE INDEX core_jobs_status_idx ON core_jobs (status, created_at);
CREATE INDEX core_jobs_item_idx ON core_jobs (work_item_id);
CREATE UNIQUE INDEX core_jobs_claim_idx ON core_jobs (runner_id, claim_id);
CREATE INDEX core_jobs_queue_idx ON core_jobs (shaping, created_at) WHERE status = 'queued';

-- The repository's `babysit` job (ADR 0585): at most one open at a time. `babysit_fence` only goes
-- up, once per job; every write the job's result leads to carries it and is refused when stale.
-- `babysit_reasons` is the JSON list of what the deliverer is waiting on the job for (at most a few:
-- the queue's head, one at a time).
ALTER TABLE core_delivery_state ADD COLUMN babysit_job_id TEXT;
ALTER TABLE core_delivery_state ADD COLUMN babysit_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_delivery_state ADD COLUMN babysit_reasons TEXT NOT NULL DEFAULT '[]';

-- A check rerun as a flake (spec 53 §4): once per check per SHA, refused a second time in code by
-- the primary key. `passed` is set when the rerun's result is known. Retention: 30 days, pruned by
-- the cron (`pruneBabysit`), oldest first in bounded batches.
CREATE TABLE core_ci_reruns (
  repository_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  check_name TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  -- The test the job named inside the check, and the check run's link: kept for flake.record.
  test_name TEXT,
  run_url TEXT,
  asked_at TEXT NOT NULL,
  passed INTEGER,
  PRIMARY KEY (repository_id, head_sha, check_name)
);
-- The cron's prune: `WHERE asked_at < ? ORDER BY asked_at LIMIT 500`.
CREATE INDEX core_ci_reruns_asked_idx ON core_ci_reruns (asked_at);

-- The known-flake list (spec 53, decision 3): a check (and the test inside it, when the job named
-- one) whose rerun passed on the same SHA. Retention: 30 days (the 14-day window that opens a fix
-- item, with room), pruned by the cron like core_ci_reruns.
CREATE TABLE core_flakes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  check_name TEXT NOT NULL,
  test_name TEXT,
  head_sha TEXT NOT NULL,
  run_url TEXT,
  work_item_id TEXT,
  seen_at TEXT NOT NULL
);
-- flake.record's "three times in 14 days": `WHERE repository_id = ? AND check_name = ? AND
-- seen_at >= ? LIMIT 2`; and babysit.wake's known-flake list for the prompt: `WHERE
-- repository_id = ? LIMIT 50` (the leading column; sorted in code).
CREATE INDEX core_flakes_check_idx ON core_flakes (repository_id, check_name, seen_at);
-- The cron's prune: `WHERE seen_at < ? ORDER BY seen_at LIMIT 500`.
CREATE INDEX core_flakes_seen_idx ON core_flakes (seen_at);

-- The backlog item opened to fix a flaky check (one per check while it is open): kept with the
-- check, a handful of rows per repository. Kept while the item exists; never grows past the
-- repository's flaky checks.
CREATE TABLE core_flake_fixes (
  repository_id TEXT NOT NULL,
  check_name TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, check_name)
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 390) WHERE key = 'schema_version';
