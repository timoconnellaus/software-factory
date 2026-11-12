-- Projects on org workflows (spec 52 PR (d), ADR 0510). A project's config names an org workflow by
-- id (`workflow: "wf_…"`) with its overrides (`workflowOverrides`); both live in the config document,
-- so they need no column. A work item pins the org config version it runs that workflow under, next
-- to the project config it pins (`policy_sha`): when shaping starts and again at the pull (release
-- takes the current version, Q4). A later org save never moves a running item onto a looser version.
-- Read with the item's row by primary key; no index.
ALTER TABLE core_work_items ADD COLUMN org_config_version INTEGER;

-- Who may decide a pending action, when not the project's approvers: `org-admin` for a project
-- config save that loosens its org workflow (an override looser than the org's value, or a switch
-- that drops a check): an org admin approves it (spec 52, Q6). Read with the pending action's row by
-- primary key (approval.decide); no index.
ALTER TABLE core_pending_actions ADD COLUMN decider TEXT;

-- An org admin's approval of a project override looser than its org workflow's value (spec 52, Q5,
-- Q6), written only by the approve path (and carried to a new org version by the factory itself
-- when that version leaves the setting's value unchanged). Never read from a config document or a
-- repository file. It counts only for that org version and that exact override value.
-- Read: scope resolution, `WHERE project_id = ? AND org_version = ?` (the primary key's prefix),
-- only for a project on an org workflow with overrides; an org config write, `WHERE org_id = ? AND
-- org_version = ?` (core_override_approvals_org_idx), to carry or lapse them.
-- Retention: one row per approved override per org version, each a person's act or its carry; kept
-- with the project (deleted with it), as the record of who allowed what. Not pruned: it grows only
-- with org config saves for projects that have an approved looser override.
CREATE TABLE core_override_approvals (
  project_id TEXT NOT NULL REFERENCES core_projects (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  org_version INTEGER NOT NULL,
  stage_id TEXT NOT NULL,
  setting TEXT NOT NULL,
  -- The override value approved, as JSON.
  value TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (project_id, org_version, stage_id, setting)
);
CREATE INDEX core_override_approvals_org_idx ON core_override_approvals (org_id, org_version);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 282) WHERE key = 'schema_version';
