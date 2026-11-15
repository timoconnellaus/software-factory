-- Migration 0433 (block AX): Chat for the new core (spec 70). A person talks to an agent that has
-- the engine's "factory" MCP server, and it sets up workflows and builds plugins. Each message a
-- person sends starts one run of the chat's agent; the run's summary is the agent's reply. Written
-- by packages/store (chats.ts).

-- An org's chats. `title` is the first message, cut to 80 characters. `agent_id` is the agent every
-- run of the chat is for.
-- Retention: kept as the chat's record until flow.chat.delete removes it (with its messages).
CREATE TABLE flow_chats (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- flow.chat.list (listChats): `WHERE org_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50`.
CREATE INDEX flow_chats_org_idx ON flow_chats (org_id, updated_at, id);

-- A chat's messages, numbered per chat from 1: what the person said (`person`), the agent's reply
-- (`agent`, its run's summary, or a plain note that the run failed), and each thing the agent did
-- during a run (`did`: a short sentence, with `data` naming the kind and id of what changed).
-- Retention: kept with its chat, as the chat's record; flow.chat.delete removes them.
CREATE TABLE flow_chat_messages (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL REFERENCES flow_chats (id),
  org_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('person', 'agent', 'did')),
  text TEXT NOT NULL,
  data TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  -- Also the index for flow.chat.get's messages (`WHERE chat_id = ? ORDER BY seq DESC LIMIT 501`),
  -- its `made` (`WHERE chat_id = ? AND role = 'did' ORDER BY seq LIMIT ?`), a run's prompt
  -- (`WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`), and each append's
  -- `SELECT MAX(seq) FROM flow_chat_messages WHERE chat_id = ?`. Two appends taking the same seq
  -- collide here, so one of them fails rather than both landing.
  UNIQUE (chat_id, seq)
);

-- A run belongs to an item or to a chat. A chat run has `chat_id`, no `item_id`, `status_id` ''
-- and `stay` = the seq of the person's message it answers; `brief` is that message. SQLite can't
-- make a column nullable, so the table is rebuilt with the same rows and indexes. Nothing
-- references flow_runs.
CREATE TABLE flow_runs_new (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  item_id TEXT REFERENCES flow_items (id),
  chat_id TEXT,
  agent_id TEXT NOT NULL,
  status_id TEXT NOT NULL,
  stay INTEGER NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
  runner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  mcp_token_hash TEXT,
  CHECK ((item_id IS NULL) <> (chat_id IS NULL))
);
INSERT INTO flow_runs_new (id, org_id, item_id, chat_id, agent_id, status_id, stay, brief, status,
    runner_id, fencing_token, lease_expires_at, result, error, created_at, claimed_at, finished_at,
    mcp_token_hash)
  SELECT id, org_id, item_id, NULL, agent_id, status_id, stay, brief, status, runner_id,
    fencing_token, lease_expires_at, result, error, created_at, claimed_at, finished_at,
    mcp_token_hash
  FROM flow_runs;
DROP TABLE flow_runs;
ALTER TABLE flow_runs_new RENAME TO flow_runs;
-- Retention: kept with its item or chat, as its record; nothing prunes runs yet.

-- The indexes the old table had (0430, 0432), with the queries that read them unchanged:
-- claimRun: `WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`.
CREATE INDEX flow_runs_queue_idx ON flow_runs (created_at, id) WHERE status = 'queued';
-- expireRuns: `WHERE status = 'claimed' AND lease_expires_at < ? ORDER BY lease_expires_at LIMIT ?`.
CREATE INDEX flow_runs_lease_idx ON flow_runs (lease_expires_at) WHERE status = 'claimed';
-- run.cancel: `UPDATE flow_runs ... WHERE item_id = ? AND stay = ? AND status IN (...)`,
-- itemRuns: `WHERE item_id = ? ORDER BY stay`, and listAgents' join on (item_id, stay).
CREATE INDEX flow_runs_item_idx ON flow_runs (item_id, stay);
-- flow.run.list by agent (runsByAgent): `WHERE agent_id = ? AND org_id = ? ORDER BY created_at
-- DESC, rowid DESC LIMIT ?`.
CREATE INDEX flow_runs_agent_idx ON flow_runs (agent_id, created_at);

-- A chat's open run: flow.chat.get's `working` and flow.chat.send's refusal (`WHERE chat_id = ?
-- AND status IN ('queued', 'claimed')`), and flow.chat.delete's cancel. Partial, so it holds only
-- chat runs.
CREATE INDEX flow_runs_chat_idx ON flow_runs (chat_id, status) WHERE chat_id IS NOT NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 433) WHERE key = 'schema_version';
