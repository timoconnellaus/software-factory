-- Migration 0110 (the sf CLI, ADR 0340): device login codes for people, and the CLI tokens they
-- mint. Only hashes of the device code and the token are stored. A token's scope is what the person
-- granted in the app (`read` or `write`); it expires and its owner can revoke it.
CREATE TABLE core_cli_device_codes (
  id TEXT PRIMARY KEY NOT NULL,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT,
  requested_scope TEXT NOT NULL DEFAULT 'read' CHECK (requested_scope IN ('read', 'write')),
  granted_scope TEXT CHECK (granted_scope IN ('read', 'write')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  decided_by TEXT REFERENCES core_user (id) ON DELETE CASCADE,
  token_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);

CREATE TABLE core_cli_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  name TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX core_cli_tokens_user_idx ON core_cli_tokens (user_id, created_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 110) WHERE key = 'schema_version';
