-- Migration 0060 (onboarding, ADR 0055–0056): GitHub App installations as org-level records, the
-- single-use state of a "Connect GitHub" round trip, the repo a project is (by GitHub's id), and
-- runner device login. Nobody types an installation id: it arrives from GitHub's redirect and is
-- verified as the App before it is stored.

-- One GitHub App installation connected to an org (ADR 0055). `installation_id` is GitHub's id; the
-- UI never shows it. Kept current by the `installation` / `installation_repositories` webhooks.
CREATE TABLE core_github_installations (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
  connected_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX core_github_installations_org_idx ON core_github_installations (org_id);

-- The `state` of one "Connect GitHub" round trip (CSRF, ADR 0055): random, stored only as its
-- SHA-256, bound to the org and the user who started it, single use, short-lived.
CREATE TABLE core_github_connect_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- A project is a repo the org's installation can reach, by GitHub's repo id (renames keep working).
ALTER TABLE core_projects ADD COLUMN installation_record_id TEXT REFERENCES core_github_installations (id);
ALTER TABLE core_projects ADD COLUMN github_repo_id INTEGER;
-- The PR that adds a template `.factory/policy.json`, when one was opened from Setup.
ALTER TABLE core_projects ADD COLUMN policy_pr_url TEXT;

-- Runner device login (ADR 0056): `sf-runner login` gets a device code (kept only as its SHA-256)
-- and a short user code; a person approves the user code in the app; the CLI's next poll receives
-- the runner's key once.
CREATE TABLE core_runner_device_codes (
  id TEXT PRIMARY KEY NOT NULL,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  suggested_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  decided_by TEXT REFERENCES core_user (id) ON DELETE CASCADE,
  runner_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 60) WHERE key = 'schema_version';
