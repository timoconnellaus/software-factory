-- Migration 0120 (planning M1, the loop: spec 20, ADRs 0300, 0301, 0302, 0350). Planning becomes a
-- live session on a runner: a planning log with a cursor, chat, presence, the session itself, the
-- kim question model, the living spec's new sections, and heavy and light runner pools.

-- The question model (ADR 0042 as amended, kim's semantics). `number` is the [Qn] of provenance
-- tags, per work item; `position` orders the open list; `revision` counts edits to the question,
-- `answer_revision` revisions of its answer. `planning_session_id` marks a question the planning
-- agent asked: only those can be answered again. `planning_round` stays for v1–v4 instances.
ALTER TABLE core_questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'
  CHECK (kind IN ('text', 'single-choice', 'multiple-choice', 'yes-no', 'number'));
ALTER TABLE core_questions ADD COLUMN default_values TEXT;
ALTER TABLE core_questions ADD COLUMN number INTEGER;
ALTER TABLE core_questions ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_questions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE core_questions ADD COLUMN answer_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_questions ADD COLUMN note TEXT;
ALTER TABLE core_questions ADD COLUMN planning_session_id TEXT;
ALTER TABLE core_questions ADD COLUMN updated_at TEXT;
CREATE INDEX core_questions_position_idx ON core_questions (work_item_id, status, position);

-- The living spec's new sections (ADR 0302): coverage and clarifications as JSON; assumptions were
-- already there. `summary` says what a revision changed.
ALTER TABLE core_specs ADD COLUMN coverage TEXT NOT NULL DEFAULT '[]';
ALTER TABLE core_specs ADD COLUMN clarifications TEXT NOT NULL DEFAULT '[]';
ALTER TABLE core_specs ADD COLUMN summary TEXT;

-- The light pool (ADR 0301). NULL: the runner reports no light pool (older runners), so it shares
-- one pool and takes no planning jobs.
ALTER TABLE core_runners ADD COLUMN light_max INTEGER;
ALTER TABLE core_runners ADD COLUMN light_in_use INTEGER NOT NULL DEFAULT 0;

-- Jobs gain the `planning` stage, a pool, and a runner they are pinned to (a planning resume goes
-- back to its session's runner). SQLite can't alter a CHECK, so core_jobs is rebuilt with the same
-- columns, indexes and data; core_runs follows it by name (D1's documented rebuild pattern).
PRAGMA defer_foreign_keys = on;

CREATE TABLE core_jobs_0120 (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('triage', 'spec', 'planning', 'build', 'verify')),
  -- The model role the harness runs as (ADR 0018).
  role TEXT NOT NULL,
  harness TEXT NOT NULL DEFAULT 'claude-code',
  requires TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL,
  -- Extra stage input (send-back notes, criteria, the planning session); small JSON.
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
  finished_at TEXT,
  -- ADR 0301: heavy (build, verify) or light (triage, spec, planning).
  pool TEXT NOT NULL DEFAULT 'heavy' CHECK (pool IN ('heavy', 'light')),
  -- Only this runner may claim it (a planning session resumes where it ran, ADR 0300).
  pinned_runner_id TEXT,
  planning_session_id TEXT
);
INSERT INTO core_jobs_0120 (
  id, work_item_id, project_id, org_id, stage, role, harness, requires, prompt, context,
  session_timeout_ms, status, wait_reason, runner_id, claim_id, run_id, created_at, claimed_at,
  finished_at, pool
)
SELECT
  id, work_item_id, project_id, org_id, stage, role, harness, requires, prompt, context,
  session_timeout_ms, status, wait_reason, runner_id, claim_id, run_id, created_at, claimed_at,
  finished_at, CASE WHEN stage IN ('triage', 'spec') THEN 'light' ELSE 'heavy' END
FROM core_jobs;
DROP TABLE core_jobs;
ALTER TABLE core_jobs_0120 RENAME TO core_jobs;
CREATE INDEX core_jobs_status_idx ON core_jobs (status, created_at);
CREATE INDEX core_jobs_item_idx ON core_jobs (work_item_id);
CREATE UNIQUE INDEX core_jobs_claim_idx ON core_jobs (runner_id, claim_id);

-- One planning session per work item at a time (ADR 0300). The conversation is a cache: the record
-- (specs, questions, chat, the log) is what a fresh session is rebuilt from.
--   starting   its job is queued or preparing
--   working    the agent is mid-turn
--   idle       waiting in its Stop hook, holding a light slot
--   yielding   asked to yield and agreed; the run is being handed back
--   yielded    no slot held; the next answer or chat message resumes it on the same runner
--   interrupted its run ended without a yield (crash, timeout, lease lost); resumes like yielded
--   ended      the spec gate was decided
--   moved      continued on another runner; a new session replaced it
CREATE TABLE core_planning_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  -- The runner it lives on (null until the first job is claimed).
  runner_id TEXT,
  -- The harness conversation (`claude --session-id/--resume`), picked by the cloud at start.
  session_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'starting' CHECK (status IN (
    'starting', 'working', 'idle', 'yielding', 'yielded', 'interrupted', 'ended', 'moved'
  )),
  current_job_id TEXT,
  -- The last planning event the agent was given (core_planning_events.id).
  delivered_cursor INTEGER NOT NULL DEFAULT 0,
  -- The Workflow's round (planning.awaitReady), the spec the agent said is ready in it, and when.
  round INTEGER NOT NULL DEFAULT 0,
  ready_spec_id TEXT,
  ready_at TEXT,
  -- Waiting at the spec gate: spec.revise is refused until it is decided.
  at_gate INTEGER NOT NULL DEFAULT 0,
  idle_since TEXT,
  agent_seen_at TEXT,
  yield_requested_at TEXT,
  -- What the agent is doing, from its last call ("revising the acceptance criteria…").
  activity TEXT,
  -- The question the agent last focused (question.focus).
  focused_question_id TEXT,
  -- An inbox card went out after the first draft.
  announced_at TEXT,
  replaces_session_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE UNIQUE INDEX core_planning_sessions_open_idx ON core_planning_sessions (work_item_id)
  WHERE status NOT IN ('ended', 'moved');
CREATE INDEX core_planning_sessions_runner_idx ON core_planning_sessions (runner_id, status);

-- The planning log: every answer, revision, chat message, presence change and agent change, in
-- order. The id is the cursor (ADR 0350).
CREATE TABLE core_planning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  type TEXT NOT NULL,
  -- 'human' (a person), 'runner' (the planning agent), 'agent' (the Workflow).
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX core_planning_events_item_idx ON core_planning_events (work_item_id, id);

-- Chat (spec 20): one row per message, from a person or the planning agent, optionally about a
-- question, optionally replying to another message.
CREATE TABLE core_planning_messages (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  question_id TEXT,
  reply_to TEXT,
  -- 'gate': a spec.requestChanges note from the approver.
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'gate')),
  delivered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX core_planning_messages_item_idx ON core_planning_messages (work_item_id, created_at);

-- Who has the Planning view open (a heartbeat from the app).
CREATE TABLE core_planning_presence (
  work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  user_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (work_item_id, user_id)
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 120) WHERE key = 'schema_version';
