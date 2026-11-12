-- Migration 0220: the factory's own check results (spec 51, ADR 0451). The runner host runs the
-- project's declared checks in the job's worktree and reports each on the hand-back; `run.handBack`
-- stores them here against the work item and the commit they ran on. They belong to that SHA only:
-- a new head has none until checks run on it. A later run on the same SHA replaces a check's row.
CREATE TABLE core_check_results (
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES core_runs (id),
  command TEXT NOT NULL,
  -- NULL when the process was killed (a timeout, a cancel).
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  -- The end of its combined output, at most 8 KB.
  log_tail TEXT NOT NULL,
  -- Which fix round of the build session this is from (0 = before any fix).
  round INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (work_item_id, head_sha, name)
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 220) WHERE key = 'schema_version';
