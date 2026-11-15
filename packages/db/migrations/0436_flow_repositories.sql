-- Migration 0436 (block AX): a new-core project can have a GitHub repository (spec 70, the software
-- plugin). The repository is reached through one of the org's GitHub App installations
-- (core_github_installations); `repo_installation_id` is GitHub's installation id, kept so a claim
-- or a plugin's `github` gateway mints a one-repository token without asking GitHub which
-- installation covers it. All nullable: a project without a repository has none of them.
-- No new index: every read of these columns is by the project's or item's primary key.
ALTER TABLE flow_projects ADD COLUMN repo_owner TEXT;
ALTER TABLE flow_projects ADD COLUMN repo_name TEXT;
ALTER TABLE flow_projects ADD COLUMN repo_default_branch TEXT;
ALTER TABLE flow_projects ADD COLUMN repo_installation_id TEXT;

-- The item's branch, `factory/flow/<key>-<number>`: set when its first run on a project with a
-- repository is claimed, and reused by every later run. `head_sha` is the branch's head as the last
-- run that ended `done` pushed it (null until then).
ALTER TABLE flow_items ADD COLUMN branch TEXT;
ALTER TABLE flow_items ADD COLUMN head_sha TEXT;

-- The branch a run worked on and the head it handed back (null for a run without a repository).
ALTER TABLE flow_runs ADD COLUMN branch TEXT;
ALTER TABLE flow_runs ADD COLUMN head_sha TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 436) WHERE key = 'schema_version';
