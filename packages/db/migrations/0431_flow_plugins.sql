-- Migration 0431 (block AX): plugins and gateways for the new core (ADR 0660, spec 70 milestone 2),
-- written by packages/store and run by packages/plugins. Item fields, timeline cards, an agent's
-- MCP servers and a run's MCP token.

-- An org's plugins: one ES module each (`code`), written by an agent from a person's plain words
-- (`request`). `fields` and `hooks` (JSON arrays) are what the module declared when it was saved,
-- read then by loading it, so a board read or a dispatch never loads a worker to find them.
-- `trigger_key` is the random key a trigger's URL carries, made when the plugin is first saved.
-- Retention: kept while the org uses it (a handful per org); flow.plugin.delete removes one.
CREATE TABLE flow_plugins (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  request TEXT NOT NULL,
  code TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '[]',
  hooks TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  trigger_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Also the index for listPlugins and enabledPlugins: `WHERE org_id = ? [AND enabled = 1]
  -- ORDER BY name`, and getPlugin by name: `WHERE org_id = ? AND name = ?`.
  UNIQUE (org_id, name)
);

-- An org's gateways: its connection to one outside system. `auth` is JSON ({ kind: "none" } |
-- { kind: "bearer" } | { kind: "header", header }); `secret` is AES-GCM ciphertext under the
-- engine's FLOW_GATEWAY_KEY, or null. No read returns `secret` except the host's own.
-- Retention: kept while the org uses it (a handful per org); flow.gateway.delete removes one.
CREATE TABLE flow_gateways (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth TEXT NOT NULL,
  secret TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Also the index for listGateways: `WHERE org_id = ? ORDER BY name`, and the host's gateway
  -- lookup: `WHERE org_id = ? AND name = ?`.
  UNIQUE (org_id, name)
);

-- An item's plugin fields, as a JSON object of field id to value. Kept with the item.
ALTER TABLE flow_items ADD COLUMN fields TEXT NOT NULL DEFAULT '{}';

-- The MCP servers an agent's runs get, as a JSON array of names ("factory": the engine's own).
ALTER TABLE flow_agents ADD COLUMN mcp TEXT NOT NULL DEFAULT '[]';

-- SHA-256 (hex) of the bearer token a claimed run presents to the engine's MCP server (/flow/mcp),
-- or null when its agent has none. Valid only while the run is claimed. Read by primary key.
ALTER TABLE flow_runs ADD COLUMN mcp_token_hash TEXT;

-- The timeline gains `card` entries (a plugin's rich card). SQLite can't change a CHECK, so the
-- table is rebuilt with the same columns, rows and index. Nothing references flow_events.
CREATE TABLE flow_events_new (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES flow_items (id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'effect', 'comment', 'card')),
  actor TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Also the timeline's index: `WHERE item_id = ? ORDER BY seq`, and the step's
  -- `SELECT MAX(seq) FROM flow_events WHERE item_id = ?`. Two writers appending the same seq
  -- collide here, so only one of them advances the item.
  UNIQUE (item_id, seq)
);
INSERT INTO flow_events_new (id, org_id, item_id, seq, kind, actor, data, created_at)
  SELECT id, org_id, item_id, seq, kind, actor, data, created_at FROM flow_events;
DROP TABLE flow_events;
ALTER TABLE flow_events_new RENAME TO flow_events;
-- Retention: kept with its item, as the item's record; nothing prunes it yet.

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 431) WHERE key = 'schema_version';
