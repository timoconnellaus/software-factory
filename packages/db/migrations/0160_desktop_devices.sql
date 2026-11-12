-- Migration 0160 (the desktop app, ADR 0391, spec 40 M1): desktop sign-in requests, desktop devices
-- with their Secure Enclave public keys, the one-time presence challenges a device signs to decide
-- a gate, and desktop tokens (CLI tokens of kind `desktop`, bound to a device). Only hashes of the
-- one-time code, the nonce and the token are stored.
CREATE TABLE core_desktop_auth_requests (
  id TEXT PRIMARY KEY NOT NULL,
  code_challenge TEXT NOT NULL,
  device_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_storage TEXT NOT NULL DEFAULT 'secure-enclave'
    CHECK (key_storage IN ('secure-enclave', 'software')),
  state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id TEXT REFERENCES core_user (id) ON DELETE CASCADE,
  code_hash TEXT UNIQUE,
  device_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  consumed_at TEXT
);

CREATE TABLE core_desktop_devices (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_storage TEXT NOT NULL CHECK (key_storage IN ('secure-enclave', 'software')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX core_desktop_devices_user_idx ON core_desktop_devices (user_id, created_at);

CREATE TABLE core_presence_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES core_desktop_devices (id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  -- What the Touch ID prompt says, written by the engine from the call; signed with the nonce.
  summary TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

ALTER TABLE core_cli_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'cli' CHECK (kind IN ('cli', 'desktop'));
ALTER TABLE core_cli_tokens ADD COLUMN device_id TEXT REFERENCES core_desktop_devices (id) ON DELETE CASCADE;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 160) WHERE key = 'schema_version';
