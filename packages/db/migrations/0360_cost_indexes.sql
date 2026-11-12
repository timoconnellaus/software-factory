-- Cloudflare cost, quick wins (AGENTS.md "Cloudflare cost"). D1 bills every row a query reads and
-- every row (and index entry) a write touches. Each index below names the query that reads it;
-- apps/engine/test/query-plans.test.ts fails if a registered hot path scans a growing table again.

-- The minute cron's expireQuietRuns (apps/engine/src/index.ts): live runs by status, not every run.
CREATE INDEX core_runs_status_idx ON core_runs (status);

-- The minute cron's pullQueuedWork (apps/engine/src/pull.ts): queued items, grouped by project.
CREATE INDEX core_work_items_status_idx ON core_work_items (status, project_id);

-- The minute cron's adjudicator verdicts (apps/engine/src/index.ts): open adjudications only.
CREATE INDEX core_adjudications_open_idx ON core_adjudications (created_at) WHERE verdict IS NULL;

-- workItem.list by org, newest first (polled): the LIMIT stops the read, no sort of the whole org.
CREATE INDEX core_work_items_org_updated_idx ON core_work_items (org_id, updated_at);

-- workItem.list by project, newest first. Replaces core_work_items_project_idx, whose
-- (project_id, status) prefix core_work_items_pull_idx already serves.
DROP INDEX IF EXISTS core_work_items_project_idx;
CREATE INDEX core_work_items_project_updated_idx ON core_work_items (project_id, updated_at);

-- inbox.list's planning sessions (polled): only announced sessions, newest first.
CREATE INDEX core_planning_sessions_announced_idx ON core_planning_sessions (announced_at)
  WHERE announced_at IS NOT NULL;

-- A planning job's session (operations/planning.ts, runners.ts): every planning call looks it up.
CREATE INDEX core_planning_sessions_job_idx ON core_planning_sessions (current_job_id)
  WHERE current_job_id IS NOT NULL;

-- The minute cron's pruneChannelStore: expired desktop sign-ins and presence challenges.
CREATE INDEX core_desktop_auth_requests_expires_idx ON core_desktop_auth_requests (expires_at);
CREATE INDEX core_presence_challenges_expires_idx ON core_presence_challenges (expires_at);

-- Indexes nothing reads (every package and app grepped), each a row written on every write:
-- no query filters work items by requester; PR lookups use (repository_id, pr_number)
-- (core_work_items_repository_idx); the audit is read by idempotency key and by work item only.
DROP INDEX IF EXISTS core_work_items_requester_idx;
DROP INDEX IF EXISTS core_work_items_pr_idx;
DROP INDEX IF EXISTS core_audit_project_idx;
DROP INDEX IF EXISTS core_audit_operation_idx;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 360) WHERE key = 'schema_version';
