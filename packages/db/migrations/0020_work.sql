-- Migration 0020: work items and everything that hangs off them: intake dedupe, stages, questions,
-- specs, pending actions (gates), review packets, incidents, the audit journal and the outbox.

-- A work item. Its Workflow instance id is its id (random, never derived from intake), so several
-- intake events can attach to one item through core_intake_keys (ADR 0006 amendment).
CREATE TABLE core_work_items (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES core_organization (id),
  project_id TEXT NOT NULL REFERENCES core_projects (id),
  -- Per-project number; the branch is factory/<number>-<slug> (ADR 0035).
  number INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('change', 'incident')),
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
CREATE INDEX core_work_items_project_idx ON core_work_items (project_id, status, updated_at);
CREATE INDEX core_work_items_org_idx ON core_work_items (org_id, status);
CREATE INDEX core_work_items_requester_idx ON core_work_items (requester_user_id, status);

-- Intake dedupe (spec 02): one row per dedupe key (source + external id, or a caller-chosen key).
CREATE TABLE core_intake_keys (
  dedupe_key TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  created_at TEXT NOT NULL
);

-- Every intake event seen, by event id. A redelivered event finds its row and is a no-op.
CREATE TABLE core_intake_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'attached')),
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX core_intake_events_item_idx ON core_intake_events (work_item_id, received_at);

-- Stage history: one row per time a work item enters a stage (send-back loops add rows).
CREATE TABLE core_stages (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'done', 'skipped', 'sent_back', 'failed', 'cancelled')),
  reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX core_stages_item_idx ON core_stages (work_item_id, started_at);

-- The Question object (ADR 0042). Interview sessions are queries over this table.
CREATE TABLE core_questions (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'product',
  prompt TEXT NOT NULL,
  context TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  default_answer TEXT,
  recommendation TEXT,
  recommendation_reason TEXT,
  blocking INTEGER NOT NULL DEFAULT 1,
  irreversible INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'owners' CHECK (visibility IN ('owners', 'assignee', 'org')),
  assignee_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'withdrawn')),
  answer TEXT,
  accepted_default INTEGER NOT NULL DEFAULT 0,
  answered_by TEXT,
  answered_at TEXT,
  planning_round INTEGER NOT NULL,
  timeout_at TEXT,
  escalated_at TEXT,
  asked_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX core_questions_item_idx ON core_questions (work_item_id, status);
CREATE INDEX core_questions_assignee_idx ON core_questions (assignee_user_id, status);

-- The living spec, one row per version. On approval it is committed to the item's branch.
CREATE TABLE core_specs (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  version INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  assumptions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  path TEXT,
  commit_sha TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  UNIQUE (work_item_id, version)
);

-- A gate decision waiting on a person (ADR 0007): a `review` answer from the gate check. The
-- approved re-run applies it. `kind` says which card the inbox shows.
CREATE TABLE core_pending_actions (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT,
  project_id TEXT,
  work_item_id TEXT,
  workflow_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('spec', 'merge', 'approval')),
  operation TEXT NOT NULL,
  risk TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  input TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  -- How it was rejected: 'rejected' (generic), 'changes_requested' (spec), 'sent_back' (merge).
  decision TEXT,
  assignee_user_id TEXT,
  escalations INTEGER NOT NULL DEFAULT 0,
  timeout_at TEXT,
  policy_sha TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT,
  -- Whether the approver opened the full diff before deciding (spec 14, criterion 8).
  opened_full_diff INTEGER,
  gate_open_ms INTEGER
);
CREATE INDEX core_pending_actions_status_idx ON core_pending_actions (status, created_at);
CREATE INDEX core_pending_actions_item_idx ON core_pending_actions (work_item_id, status);
CREATE INDEX core_pending_actions_assignee_idx ON core_pending_actions (assignee_user_id, status);

-- The review packet: what the approver sees at the merge gate (ADR 0020, 0041). One row per verify
-- pass; the newest for the item's head SHA is the merge gate.
CREATE TABLE core_review_packets (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  run_id TEXT,
  head_sha TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
  summary TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT '[]',
  checks TEXT NOT NULL DEFAULT '[]',
  reviewer TEXT,
  risk_flags TEXT NOT NULL DEFAULT '[]',
  sections TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX core_review_packets_item_idx ON core_review_packets (work_item_id, created_at);

-- A factory incident (V1 scope): opened when a PR is sent back or a run fails or stalls. It is
-- itself a work item (`fix_work_item_id`) proposing a `.factory/` change.
CREATE TABLE core_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_work_item_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sent_back', 'run_failed', 'run_stalled', 'manual')),
  reason TEXT NOT NULL,
  fix_work_item_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX core_incidents_project_idx ON core_incidents (project_id, created_at);

-- The audit journal (ADR 0011): one row per write, refusal and failure. Append-only. Metrics are
-- SQL over it.
CREATE TABLE core_audit (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'review', 'deny', 'n/a')),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('ok', 'review', 'denied', 'forbidden', 'killed', 'fenced', 'failed')),
  reason TEXT,
  org_id TEXT,
  project_id TEXT,
  work_item_id TEXT,
  -- The default-branch SHA the policy came from (spec 01, criterion 8).
  policy_sha TEXT,
  input TEXT NOT NULL,
  result TEXT,
  -- What changed: [{ entity, id, before, after }] (spec 01, criterion 6).
  diff TEXT NOT NULL DEFAULT '[]',
  pending_action_id TEXT,
  approval_id TEXT,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX core_audit_item_idx ON core_audit (work_item_id, at);
CREATE INDEX core_audit_project_idx ON core_audit (project_id, at);
CREATE INDEX core_audit_operation_idx ON core_audit (operation, at);

CREATE TRIGGER core_audit_no_update BEFORE UPDATE ON core_audit
BEGIN SELECT RAISE(ABORT, 'core_audit is append-only'); END;
CREATE TRIGGER core_audit_no_delete BEFORE DELETE ON core_audit
BEGIN SELECT RAISE(ABORT, 'core_audit is append-only'); END;

-- The outbox (ADR 0012): written in the same batch as the change it announces, delivered after
-- commit by sf-engine, retried by its cron. Delivered rows are deleted.
CREATE TABLE core_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX core_outbox_next_idx ON core_outbox (next_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 20) WHERE key = 'schema_version';
