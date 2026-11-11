-- Migration 0080 (attach an outside PR, spec 05, ADR 0290): a work item may be `attached`, a pull
-- request opened outside the factory that the factory verifies and takes through the merge gate.
-- SQLite can't alter a CHECK, so core_work_items is rebuilt with the same columns, indexes and data.
-- Its children reference it by name, so they follow the rebuilt table; foreign keys are deferred
-- for the rebuild (Cloudflare's documented pattern for D1).
PRAGMA defer_foreign_keys = on;

CREATE TABLE core_work_items_0080 (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id),
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  -- Per-project number; the branch is factory/<number>-<slug> (ADR 0035), or the PR's own head
  -- branch for an attached item.
  number INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- 'attached': a PR opened outside the factory (spec 05). The factory never pushes to its branch.
  kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change', 'incident', 'attached')),
  requester_user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'intake'
    CHECK (stage IN ('intake', 'triage', 'spec', 'build', 'verify', 'merge', 'done')),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting', 'paused', 'done', 'failed', 'rejected', 'cancelled')),
  status_reason TEXT,
  size TEXT CHECK (size IN ('small', 'medium', 'large')),
  spec_required INTEGER,
  -- The triage decision about the spec stage and why (spec 02, criterion 2).
  spec_decision_reason TEXT,
  domains TEXT NOT NULL DEFAULT '[]',
  current_spec_id TEXT,
  branch TEXT NOT NULL,
  head_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  -- Bumped by workItem.awaitQuestions; names the event question answers send (`questions-<id>-<round>`).
  planning_round INTEGER NOT NULL DEFAULT 0,
  -- Build and verify send-back counts, for the retry limit and metrics.
  build_attempts INTEGER NOT NULL DEFAULT 0,
  workflow_id TEXT NOT NULL UNIQUE,
  workflow_version INTEGER,
  -- The policy SHA in force when the item was created (ADR 0036).
  policy_sha TEXT,
  parent_work_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (project_id, number)
);

INSERT INTO core_work_items_0080 (
  id, org_id, project_id, number, slug, title, body, kind, requester_user_id, source, stage,
  status, status_reason, size, spec_required, spec_decision_reason, domains, current_spec_id,
  branch, head_sha, pr_number, pr_url, planning_round, build_attempts, workflow_id,
  workflow_version, policy_sha, parent_work_item_id, created_at, updated_at, closed_at
)
SELECT
  id, org_id, project_id, number, slug, title, body, kind, requester_user_id, source, stage,
  status, status_reason, size, spec_required, spec_decision_reason, domains, current_spec_id,
  branch, head_sha, pr_number, pr_url, planning_round, build_attempts, workflow_id,
  workflow_version, policy_sha, parent_work_item_id, created_at, updated_at, closed_at
FROM core_work_items;

DROP TABLE core_work_items;
ALTER TABLE core_work_items_0080 RENAME TO core_work_items;

CREATE INDEX core_work_items_project_idx ON core_work_items (project_id, status, updated_at);
CREATE INDEX core_work_items_org_idx ON core_work_items (org_id, status);
CREATE INDEX core_work_items_requester_idx ON core_work_items (requester_user_id, status);
-- verify.refresh finds an attached item by its PR number on every pull_request event.
CREATE INDEX core_work_items_pr_idx ON core_work_items (project_id, pr_number);

PRAGMA defer_foreign_keys = off;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 80) WHERE key = 'schema_version';
