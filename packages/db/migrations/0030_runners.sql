-- Migration 0030: runners, jobs, runs, leases with fencing tokens, run events and artifacts, and
-- the runner channel's idempotency store (ADR 0016, 0035, spike ADR 0100).

-- A runner, owned by a user (ADR 0023). Its channel key is derived from RUNNER_CHANNEL_SECRET and
-- `key_version`; bumping the version revokes this runner alone. No key is stored.
CREATE TABLE core_runners (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  manifest TEXT,
  capacity_max INTEGER NOT NULL DEFAULT 0,
  capacity_in_use INTEGER NOT NULL DEFAULT 0,
  accepting INTEGER NOT NULL DEFAULT 0,
  rate_limited_until TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX core_runners_owner_idx ON core_runners (owner_user_id);

-- A runner's sharing allowlist (ADR 0038). Owner-only when it has no rows. Milestone (c).
CREATE TABLE core_runner_shares (
  runner_id TEXT NOT NULL REFERENCES core_runners (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'factory', 'project')),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (runner_id, scope, scope_id)
);

-- A job: one stage's assignment, queued until a runner claims it. A retry is a new job.
CREATE TABLE core_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('triage', 'spec', 'build', 'verify')),
  -- The model role the harness runs as (ADR 0018).
  role TEXT NOT NULL,
  harness TEXT NOT NULL DEFAULT 'claude-code',
  requires TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL,
  -- Extra stage input (send-back notes, criteria); small JSON.
  context TEXT NOT NULL DEFAULT '{}',
  session_timeout_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  -- Why a queued job is not being placed, e.g. 'waiting on review' (WIP limit).
  wait_reason TEXT,
  runner_id TEXT,
  claim_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT
);
CREATE INDEX core_jobs_status_idx ON core_jobs (status, created_at);
CREATE INDEX core_jobs_item_idx ON core_jobs (work_item_id);
CREATE UNIQUE INDEX core_jobs_claim_idx ON core_jobs (runner_id, claim_id);

-- A run: one execution of a job on a runner, on its own branch factory/<n>-<slug>-run-<k>.
CREATE TABLE core_runs (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES core_jobs (id),
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  run_no INTEGER NOT NULL,
  stage TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'preparing', 'running', 'collecting', 'handed_back', 'failed', 'cancelled')),
  outcome TEXT,
  summary TEXT,
  head_sha TEXT,
  result TEXT,
  takeover TEXT,
  started_at TEXT NOT NULL,
  last_event_at TEXT,
  ended_at TEXT,
  released_at TEXT,
  UNIQUE (work_item_id, run_no)
);
CREATE INDEX core_runs_runner_idx ON core_runs (runner_id, status);

-- Events streamed by a run, deduped on (run, seq).
CREATE TABLE core_run_events (
  run_id TEXT NOT NULL REFERENCES core_runs (id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Artifacts a run uploaded; the id is a content hash, so a re-upload is a no-op. Bodies are inline
-- and capped; large ones go to R2 later (`r2_key`).
CREATE TABLE core_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES core_runs (id),
  kind TEXT NOT NULL,
  name TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  body TEXT,
  r2_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX core_artifacts_run_idx ON core_artifacts (run_id);

-- One lease per work item (ADR 0035). `fencing_token` only ever increases; every write from the
-- holder carries it and a stale one is refused.
CREATE TABLE core_leases (
  work_item_id TEXT PRIMARY KEY NOT NULL REFERENCES core_work_items (id),
  holder_kind TEXT CHECK (holder_kind IN ('run', 'session')),
  holder_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  expires_at TEXT,
  released_at TEXT
);

-- The runner channel's idempotency store: (runner, idempotency key) → the first response.
CREATE TABLE core_channel_requests (
  runner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  response_status INTEGER,
  response TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (runner_id, idempotency_key)
);
CREATE INDEX core_channel_requests_at_idx ON core_channel_requests (at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 30) WHERE key = 'schema_version';
