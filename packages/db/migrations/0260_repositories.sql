-- Migration 0260 (spec 50 part A, ADR 0490): a project is not a repository. The repo half of each
-- project moves to core_repositories, one backfilled per existing project; project ids, names,
-- numbers and config versions are unchanged, so every project_id elsewhere stays valid. A project
-- may now have zero or more repositories, and a work item names the one it uses.
--
-- core_projects is rebuilt without its repo columns (SQLite can't drop a column that is in a UNIQUE
-- or a foreign key). Dropping a parent table deletes its rows first, and that runs ON DELETE CASCADE
-- in every child even with foreign keys deferred, and D1 can't turn foreign keys off. So the rows of
-- the tables that cascade from core_projects are copied aside first and put back after the rebuild:
-- core_project_policies, core_project_protection, core_merge_queue, core_config_trials and
-- core_verify_checks (every `REFERENCES core_projects (id) ON DELETE CASCADE` up to 0250). A later
-- migration that rebuilds core_projects must do the same for whatever cascades from it then.

CREATE TABLE core_0260_projects AS SELECT * FROM core_projects;
CREATE TABLE core_0260_policies AS SELECT * FROM core_project_policies;
CREATE TABLE core_0260_protection AS SELECT * FROM core_project_protection;
CREATE TABLE core_0260_merge_queue AS SELECT * FROM core_merge_queue;
CREATE TABLE core_0260_trials AS SELECT * FROM core_config_trials;
CREATE TABLE core_0260_verify_checks AS SELECT * FROM core_verify_checks;

-- The rebuild, as in 0080: children reference core_projects by name and follow the new table.
-- Foreign keys are deferred, so the work items (no cascade) are valid again once the ids are back.
PRAGMA defer_foreign_keys = on;

CREATE TABLE core_projects_0260 (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  factory_id TEXT NOT NULL REFERENCES core_factories (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- The config version in force (ADR 0370; `v<N>`, or a commit SHA from before 0140). NULL: none
  -- yet, so non-human calls fail closed.
  policy_sha TEXT,
  -- Per-project counter for work item numbers (branch names use the number).
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (org_id, slug)
);

INSERT INTO core_projects_0260 (
  id, org_id, factory_id, name, slug, policy_sha, next_number, created_at, created_by
)
SELECT id, org_id, factory_id, name, slug, policy_sha, next_number, created_at, created_by
FROM core_0260_projects;

DROP TABLE core_projects;
ALTER TABLE core_projects_0260 RENAME TO core_projects;
CREATE INDEX core_projects_factory_idx ON core_projects (factory_id);

-- Put back what the drop cascaded away.
INSERT INTO core_project_policies SELECT * FROM core_0260_policies;
INSERT INTO core_project_protection SELECT * FROM core_0260_protection;
INSERT INTO core_merge_queue SELECT * FROM core_0260_merge_queue;
INSERT INTO core_config_trials SELECT * FROM core_0260_trials;
INSERT INTO core_verify_checks SELECT * FROM core_0260_verify_checks;

PRAGMA defer_foreign_keys = off;

CREATE TABLE core_repositories (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  github_installation_id TEXT,
  -- The org's installation record the repo is reached through (ADR 0055).
  installation_record_id TEXT REFERENCES core_github_installations (id),
  -- GitHub's repo id (survives renames).
  github_repo_id INTEGER,
  -- The open PR adding a template `.factory/policy.json`, if one was opened from Setup.
  policy_pr_url TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (owner, name)
);
CREATE INDEX core_repositories_project_idx ON core_repositories (project_id, created_at);
CREATE INDEX core_repositories_org_idx ON core_repositories (org_id);

-- One repository per project, with a deterministic id (`repo_` + the project id's hex).
INSERT INTO core_repositories (
  id, org_id, project_id, owner, name, default_branch, github_installation_id,
  installation_record_id, github_repo_id, policy_pr_url, created_at, created_by
)
SELECT
  'repo_' || substr(id, 5), org_id, id, repo_owner, repo_name, default_branch,
  github_installation_id, installation_record_id, github_repo_id, policy_pr_url, created_at,
  created_by
FROM core_0260_projects;

-- The repository a work item uses (ADR 0490). Null: none chosen yet (a project with several, or
-- none). Every existing item gets its project's repository.
ALTER TABLE core_work_items ADD COLUMN repository_id TEXT REFERENCES core_repositories (id);
UPDATE core_work_items
SET repository_id = (SELECT r.id FROM core_repositories r WHERE r.project_id = core_work_items.project_id);
CREATE INDEX core_work_items_repository_idx ON core_work_items (repository_id, pr_number);

DROP TABLE core_0260_projects;
DROP TABLE core_0260_policies;
DROP TABLE core_0260_protection;
DROP TABLE core_0260_merge_queue;
DROP TABLE core_0260_trials;
DROP TABLE core_0260_verify_checks;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 260) WHERE key = 'schema_version';
