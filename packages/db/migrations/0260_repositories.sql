-- Migration 0260 (spec 50 part A, ADR 0490): a project is not a repository. The repo half of each
-- project moves to core_repositories, one backfilled per existing project, and a work item names
-- the repository it uses. Project ids, names, numbers and config versions are unchanged.
--
-- Additive only: the repo columns stay on core_projects for now (unread by the code from this
-- release on, still written as a mirror by project.create), because the code deployed before this
-- release reads them until the Worker deploy lands, and a failed deploy must leave production
-- working. A later migration, once this code is live, backfills a repository for any project
-- created in that gap and drops the columns (it rebuilds core_projects: see 0261's note on
-- copying aside the rows of tables that cascade from it).
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
FROM core_projects;

-- The repository a work item uses (ADR 0490). Null: none chosen yet (a project with several, or
-- none). Every existing item gets its project's repository.
ALTER TABLE core_work_items ADD COLUMN repository_id TEXT REFERENCES core_repositories (id);
UPDATE core_work_items
SET repository_id = (SELECT r.id FROM core_repositories r WHERE r.project_id = core_work_items.project_id);
CREATE INDEX core_work_items_repository_idx ON core_work_items (repository_id, pr_number);
CREATE INDEX core_work_items_repository_head_idx ON core_work_items (repository_id, head_sha);

-- factory/verify per head SHA is per repository (a project may have several).
ALTER TABLE core_verify_checks ADD COLUMN repository_id TEXT REFERENCES core_repositories (id);
UPDATE core_verify_checks
SET repository_id = (SELECT r.id FROM core_repositories r WHERE r.project_id = core_verify_checks.project_id);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 260) WHERE key = 'schema_version';
