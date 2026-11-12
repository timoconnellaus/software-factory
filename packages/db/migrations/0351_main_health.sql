-- Migration 0351 (spec 53, ADR 0581): whether each repository's default branch is green, and the
-- open red episode that stops the line.
--
-- One row per repository, from `main.observe` (the GitHub connector on a check suite or a push to
-- the default branch). `state` is the head's CI: green, red or pending. A red episode opens at the
-- first red head after a green one (`red_since`, `first_red_sha`) and closes at the next green head;
-- while it is open only repairs land. `last_green_sha` is where the episode's suspects start.
CREATE TABLE core_main_health (
  repository_id TEXT PRIMARY KEY NOT NULL REFERENCES core_repositories (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('green', 'red', 'pending')),
  -- JSON array of the failing check names on the head.
  failing TEXT NOT NULL DEFAULT '[]',
  last_green_sha TEXT,
  red_since TEXT,
  first_red_sha TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX core_main_health_red_idx ON core_main_health (project_id, red_since);

-- A work item whose merge repairs a red default branch (a fix or a revert): it lands while the
-- line is stopped, ahead of everything else in its queue. Set by a person (`workItem.markRepair`)
-- or, later, by the babysit job.
ALTER TABLE core_work_items ADD COLUMN repairs_main INTEGER NOT NULL DEFAULT 0;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 351) WHERE key = 'schema_version';
