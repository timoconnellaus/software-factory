-- Migration 0437 (block AX): Chat talks to a model, not to an agent (spec 70, "Chat"). A chat keeps
-- the person's choice of model and effort (Claude Code's own aliases and effort levels; null = the
-- runner's default), and no longer names an agent: `agent_id` becomes nullable and new chats leave
-- it null. Chats from before keep theirs, unused. A chat run stores `agent_id = ''` in flow_runs,
-- which joins no agent. Agents get a model and effort too, used the same way for an item's run.
-- Written by packages/store (chats.ts, agents.ts).
--
-- `flow_chat_messages.role` keeps the stored value 'agent' for the model's replies; the API calls
-- them 'assistant' (packages/store chats.ts), so no message row is rewritten.

-- flow_chats is rebuilt (SQLite can't make a column nullable), under its own name, since
-- flow_chat_messages references it by name. Rows written: twice the chat count, plus one index
-- entry per chat.
PRAGMA defer_foreign_keys = on;

CREATE TABLE flow_chats_0437_copy AS SELECT * FROM flow_chats;
DROP TABLE flow_chats;

-- An org's chats. `title` is the first message, cut to 80 characters. `model` and `effort` are
-- what each new run of the chat starts Claude Code with. `agent_id` is set only on chats from
-- before this migration.
-- Retention: kept as the chat's record until flow.chat.delete removes it (with its messages).
CREATE TABLE flow_chats (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  agent_id TEXT,
  title TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO flow_chats (id, org_id, agent_id, title, model, effort, created_by, created_at,
    updated_at)
  SELECT id, org_id, agent_id, title, NULL, NULL, created_by, created_at, updated_at
  FROM flow_chats_0437_copy;
DROP TABLE flow_chats_0437_copy;

-- As 0433: flow.chat.list (listChats): `WHERE org_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50`.
CREATE INDEX flow_chats_org_idx ON flow_chats (org_id, updated_at, id);

-- An agent's model and effort for its runs (null = the runner's default).
ALTER TABLE flow_agents ADD COLUMN model TEXT;
ALTER TABLE flow_agents ADD COLUMN effort TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 437) WHERE key = 'schema_version';
