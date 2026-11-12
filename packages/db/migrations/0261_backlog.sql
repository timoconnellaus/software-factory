-- Migration 0261 (spec 50 part B, ADR 0491): work starts in a backlog and is released. A work item
-- may be `backlog` (captured), `ready` (shaped) or `queued` (released, waiting for a slot) before
-- its pipeline starts; `planning` is reserved for part C (planning before release) so it needs no
-- second rebuild. Items gain a priority and a manual rank, and "waits for" links between items.
--
-- SQLite can't alter a CHECK, so core_work_items is rebuilt as in 0080. Dropping it runs ON DELETE
-- CASCADE in its children even with foreign keys deferred (see 0260), so the rows of the tables that
-- cascade from it are copied aside and put back: core_merge_queue and core_attachments (every
-- `REFERENCES core_work_items (id) ON DELETE CASCADE` up to 0260).

CREATE TABLE core_0261_merge_queue AS SELECT * FROM core_merge_queue;
CREATE TABLE core_0261_attachments AS SELECT * FROM core_attachments;

PRAGMA defer_foreign_keys = on;

CREATE TABLE core_work_items_0261 (
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
  -- backlog → ready → queued before the pipeline (no Workflow instance yet); planning is part C's.
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('backlog', 'planning', 'ready', 'queued', 'running', 'waiting', 'paused',
                      'done', 'failed', 'rejected', 'cancelled')),
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
  -- The config version in force when the pipeline started (ADR 0370, 0491).
  policy_sha TEXT,
  parent_work_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  -- 0141 (ADR 0371, 0492): the item's workflow; null is the skeleton alone.
  workflow TEXT,
  workflow_reason TEXT,
  -- 0142 (ADR 0373): the trial it runs under, on the trial's candidate version.
  trial_id TEXT,
  -- 0260 (ADR 0490): the repository it uses; null when none is chosen yet.
  repository_id TEXT REFERENCES core_repositories (id),
  -- 0261 (ADR 0491): 0 urgent, 1 high, 2 normal, 3 low; the pull takes lower first.
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  -- The order within a priority (lower first), set by workItem.reorder.
  rank REAL NOT NULL DEFAULT 0,
  -- JSON string[]: criteria written while shaping, before triage drafts the spec.
  acceptance_criteria TEXT,
  released_at TEXT,
  released_by TEXT,
  -- When the pipeline started (the pull). Null for items from before 0261 and those not started.
  pulled_at TEXT,
  UNIQUE (project_id, number)
);

INSERT INTO core_work_items_0261 (
  id, org_id, project_id, number, slug, title, body, kind, requester_user_id, source, stage,
  status, status_reason, size, spec_required, spec_decision_reason, domains, current_spec_id,
  branch, head_sha, pr_number, pr_url, planning_round, build_attempts, workflow_id,
  workflow_version, policy_sha, parent_work_item_id, created_at, updated_at, closed_at,
  workflow, workflow_reason, trial_id, repository_id
)
SELECT
  id, org_id, project_id, number, slug, title, body, kind, requester_user_id, source, stage,
  status, status_reason, size, spec_required, spec_decision_reason, domains, current_spec_id,
  branch, head_sha, pr_number, pr_url, planning_round, build_attempts, workflow_id,
  workflow_version, policy_sha, parent_work_item_id, created_at, updated_at, closed_at,
  workflow, workflow_reason, trial_id, repository_id
FROM core_work_items;

DROP TABLE core_work_items;
ALTER TABLE core_work_items_0261 RENAME TO core_work_items;

CREATE INDEX core_work_items_project_idx ON core_work_items (project_id, status, updated_at);
CREATE INDEX core_work_items_org_idx ON core_work_items (org_id, status);
CREATE INDEX core_work_items_requester_idx ON core_work_items (requester_user_id, status);
CREATE INDEX core_work_items_pr_idx ON core_work_items (project_id, pr_number);
CREATE INDEX core_work_items_repository_idx ON core_work_items (repository_id, pr_number);
-- The pull (ADR 0491): a project's queued items by priority, then rank.
CREATE INDEX core_work_items_pull_idx ON core_work_items (project_id, status, priority, rank);

INSERT INTO core_merge_queue SELECT * FROM core_0261_merge_queue;
INSERT INTO core_attachments SELECT * FROM core_0261_attachments;

PRAGMA defer_foreign_keys = off;

DROP TABLE core_0261_merge_queue;
DROP TABLE core_0261_attachments;

-- "Waits for" (ADR 0491): the item isn't pulled until every item it waits for is done. Same org,
-- any project; no cycles (checked by workItem.link).
CREATE TABLE core_work_item_links (
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id) ON DELETE CASCADE,
  waits_for_id TEXT NOT NULL REFERENCES core_work_items (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (work_item_id, waits_for_id),
  CHECK (work_item_id <> waits_for_id)
);
CREATE INDEX core_work_item_links_waits_for_idx ON core_work_item_links (waits_for_id);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 261) WHERE key = 'schema_version';
