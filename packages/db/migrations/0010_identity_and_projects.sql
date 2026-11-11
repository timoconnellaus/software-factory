-- Migration 0010: identity (Better Auth, mapped onto core_*), orgs, factories, projects, policy
-- snapshots and kill switches. Every table is core_* and snake_case (ADR 0024 amendment).
--
-- Better Auth tables (core_user … core_invitation) follow Better Auth 1.7 + the organization
-- plugin field for field, with camelCase fields mapped to snake_case columns. The app session wires
-- Better Auth with `modelName: "core_<model>"` and a `fields` map (see packages/db/README.md).
-- Better Auth writes these tables itself; everything else is written only through operations.

CREATE TABLE core_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE core_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  -- GitHub login, filled from the GitHub account on sign-in; approvers in `.factory/` name logins.
  github_login TEXT UNIQUE,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE TABLE core_session (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at DATE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  active_organization_id TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_session_user_id_idx ON core_session (user_id);

CREATE TABLE core_account (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at DATE,
  refresh_token_expires_at DATE,
  scope TEXT,
  password TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_account_user_id_idx ON core_account (user_id);

CREATE TABLE core_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_verification_identifier_idx ON core_verification (identifier);

-- An org (Better Auth organization plugin). `kind` is 'personal' for a user's Personal org.
CREATE TABLE core_organization (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  kind TEXT NOT NULL DEFAULT 'team' CHECK (kind IN ('personal', 'team', 'client')),
  -- The org's GitHub App installation (ADR 0025); projects may override it.
  github_installation_id TEXT,
  created_at DATE NOT NULL
);

CREATE TABLE core_member (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  -- Better Auth roles: owner, admin, member. Owners and admins are org admins (ADR 0044).
  role TEXT NOT NULL,
  created_at DATE NOT NULL,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX core_member_user_id_idx ON core_member (user_id);

CREATE TABLE core_invitation (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL,
  expires_at DATE NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  created_at DATE NOT NULL
);
CREATE INDEX core_invitation_organization_id_idx ON core_invitation (organization_id);
CREATE INDEX core_invitation_email_idx ON core_invitation (email);

-- A factory: a group of projects inside an org (CONTEXT.md).
CREATE TABLE core_factories (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX core_factories_org_idx ON core_factories (org_id);

-- A project: one repo inside a factory, configured by its committed `.factory/`.
CREATE TABLE core_projects (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id) ON DELETE CASCADE,
  factory_id TEXT NOT NULL REFERENCES core_factories (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  github_installation_id TEXT,
  -- The default-branch SHA whose `.factory/` policy is in force (ADR 0036). NULL: none synced yet,
  -- so non-human calls fail closed.
  policy_sha TEXT,
  -- Per-project counter for work item numbers (branch names use the number).
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (org_id, slug),
  UNIQUE (repo_owner, repo_name)
);
CREATE INDEX core_projects_factory_idx ON core_projects (factory_id);

-- `.factory/` policy as read from the default branch at one SHA (ADR 0036). Kept per SHA so every
-- audit row can say which policy it was decided under. `valid = 0` rows fail closed.
CREATE TABLE core_project_policies (
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  ref TEXT NOT NULL,
  raw TEXT NOT NULL,
  valid INTEGER NOT NULL,
  error TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (project_id, sha)
);

-- Kill switches, per org and per project (ADR 0044). `epoch` goes up each time a switch turns on,
-- so a stale resume event can never release a later park.
CREATE TABLE core_kill_switches (
  scope TEXT NOT NULL CHECK (scope IN ('org', 'project')),
  scope_id TEXT NOT NULL,
  is_on INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);

-- A batch guard (ADR 0050): a guarded write inserts a row here with ok = 0 when its condition
-- failed, which aborts the whole D1 batch. The last statement of every batch empties the table.
CREATE TABLE core_batch_guard (
  name TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok > 0)
);

INSERT INTO core_meta (key, value) VALUES ('schema_version', '10');
