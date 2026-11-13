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
  checked_at TEXT NOT NULL,
  -- Where this observation sits in time, by what the engine itself knows (second review of #104):
  -- when it read the branch's head and checks (`observed_at`), then GitHub's newest check run id on
  -- that head (a rerun is a new run with a higher id) as a tiebreak. Never commit dates: the pusher
  -- sets those. `main.observe` writes only a newer observation (compared in SQL in the same batch),
  -- so a push and a check suite arriving together, or a late read, never put an older state back.
  observed_at TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0,
  -- Who is told about the open red episode (JSON user ids, fixed when it opens): the project's
  -- approvers, owner question 4's recommendation. The Inbox card goes to them only.
  audience TEXT NOT NULL DEFAULT '[]'
);
-- `delivery.status` reads a project's rows; the inbox reaches them through the caller's projects.
CREATE INDEX core_main_health_project_idx ON core_main_health (project_id);

-- A work item whose merge repairs a red default branch (a fix or a revert): it lands while the
-- line is stopped, ahead of everything else in its queue. Set by a person (`workItem.markRepair`)
-- or, later, by the babysit job.
ALTER TABLE core_work_items ADD COLUMN repairs_main INTEGER NOT NULL DEFAULT 0;
-- `main.observe` clears a closed episode's repairs (UPDATE … WHERE repository_id = ? AND
-- repairs_main = 1, once per episode): only the few marked items are in it.
CREATE INDEX core_work_items_repair_idx ON core_work_items (repository_id) WHERE repairs_main = 1;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 351) WHERE key = 'schema_version';
