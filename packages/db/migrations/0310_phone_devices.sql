-- Migration 0310 (the phone app, spec 60 PR 1a, ADR 0541): phones are devices like Macs.
-- - core_desktop_devices keeps its name and every row. It gains `platform` (macos|android),
--   `attestation` (the parsed Android key attestation, JSON) and `decides` (fingerprint approvals on
--   or off), and `key_storage` widens to secure-enclave|strongbox|tee|software.
-- - core_desktop_auth_requests gains `platform`, `attestation` and `offer_id`, and the same widening.
-- - core_cli_tokens' `kind` allows `mobile` (`sfm_` tokens, bound to a device).
-- - core_presence_challenges is rebuilt only because it references the devices table.
-- - New: core_mobile_nonces (the one-use attestation challenge), core_pair_offers (Add a phone)
--   and core_pair_code_tries (the hourly cap on typed codes).
--
-- SQLite can't change a CHECK in place, so the tables are rebuilt. The rebuilt children are made
-- to reference the *new* devices table before the old one is dropped: dropping a parent with
-- foreign keys on runs an implicit DELETE, which would cascade to every token and challenge. The
-- final RENAME rewrites the children's references to the kept name. The push tables and the policy
-- digest that spec 60 lists for 0310 come with the PRs that use them (2 and 8).
PRAGMA defer_foreign_keys = on;

CREATE TABLE core_desktop_devices_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_storage TEXT NOT NULL
    CHECK (key_storage IN ('secure-enclave', 'strongbox', 'tee', 'software')),
  platform TEXT NOT NULL DEFAULT 'macos' CHECK (platform IN ('macos', 'android')),
  attestation TEXT,
  decides INTEGER NOT NULL DEFAULT 1 CHECK (decides IN (0, 1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
INSERT INTO core_desktop_devices_v2
  (id, user_id, name, public_key, key_storage, platform, attestation, decides, created_at, last_seen_at, revoked_at)
  SELECT id, user_id, name, public_key, key_storage, 'macos', NULL, 1, created_at, last_seen_at, revoked_at
  FROM core_desktop_devices;

CREATE TABLE core_cli_tokens_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  name TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  kind TEXT NOT NULL DEFAULT 'cli' CHECK (kind IN ('cli', 'desktop', 'mobile')),
  device_id TEXT REFERENCES core_desktop_devices_v2 (id) ON DELETE CASCADE
);
INSERT INTO core_cli_tokens_v2
  (id, token_hash, user_id, name, scope, created_at, expires_at, revoked_at, kind, device_id)
  SELECT id, token_hash, user_id, name, scope, created_at, expires_at, revoked_at, kind, device_id
  FROM core_cli_tokens;

CREATE TABLE core_presence_challenges_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES core_desktop_devices_v2 (id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
INSERT INTO core_presence_challenges_v2
  SELECT id, device_id, op, input_digest, summary, nonce_hash, created_at, expires_at, consumed_at
  FROM core_presence_challenges;

CREATE TABLE core_desktop_auth_requests_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  code_challenge TEXT NOT NULL,
  device_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_storage TEXT NOT NULL DEFAULT 'secure-enclave'
    CHECK (key_storage IN ('secure-enclave', 'strongbox', 'tee', 'software')),
  platform TEXT NOT NULL DEFAULT 'macos' CHECK (platform IN ('macos', 'android')),
  attestation TEXT,
  -- The pair offer (Add a phone) that approved this sign-in, when it came by QR or typed code.
  offer_id TEXT,
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
INSERT INTO core_desktop_auth_requests_v2
  (id, code_challenge, device_name, public_key, key_storage, platform, attestation, offer_id, state,
   status, user_id, code_hash, device_id, created_at, expires_at, decided_at, consumed_at)
  SELECT id, code_challenge, device_name, public_key, key_storage, 'macos', NULL, NULL, state,
   status, user_id, code_hash, device_id, created_at, expires_at, decided_at, consumed_at
  FROM core_desktop_auth_requests;

-- Children first, then the parent: nothing references the old devices table when it goes.
DROP TABLE core_presence_challenges;
DROP TABLE core_cli_tokens;
DROP TABLE core_desktop_auth_requests;
DROP TABLE core_desktop_devices;

ALTER TABLE core_desktop_devices_v2 RENAME TO core_desktop_devices;
ALTER TABLE core_cli_tokens_v2 RENAME TO core_cli_tokens;
ALTER TABLE core_presence_challenges_v2 RENAME TO core_presence_challenges;
ALTER TABLE core_desktop_auth_requests_v2 RENAME TO core_desktop_auth_requests;

CREATE INDEX core_desktop_devices_user_idx ON core_desktop_devices (user_id, created_at);
CREATE INDEX core_cli_tokens_user_idx ON core_cli_tokens (user_id, created_at);
CREATE INDEX core_cli_tokens_device_idx ON core_cli_tokens (device_id);

-- The challenge a phone's Keystore key is generated with (ADR 0541 decision 2): one use, 5
-- minutes, stored only as the SHA-256 of the nonce. `caller` is a hash of the network address the
-- door saw (an IPv4 address or an IPv6 /64), for the per-caller limit on unspent nonces.
CREATE TABLE core_mobile_nonces (
  nonce_hash TEXT PRIMARY KEY NOT NULL,
  caller TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX core_mobile_nonces_live_idx ON core_mobile_nonces (consumed_at, expires_at);
CREATE INDEX core_mobile_nonces_caller_idx ON core_mobile_nonces (caller, expires_at);

-- Add a phone (ADR 0541 decision 6): the offer is the approval, made by a signed-in person on the
-- website or on the desktop with Touch ID. One use, 5 minutes. The QR's secret and the typed code
-- are stored only as hashes; `code_tag` (the typed code's first two characters) finds the offer a
-- wrong code counts against.
CREATE TABLE core_pair_offers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  -- Where the person made the offer: the website (`app`) or a desktop device.
  surface TEXT NOT NULL CHECK (surface IN ('app', 'desktop')),
  secret_hash TEXT NOT NULL UNIQUE,
  code_tag TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  closed_at TEXT,
  -- The phone that paired through it (set by mobile.authExchange).
  device_id TEXT
);
CREATE INDEX core_pair_offers_tag_idx ON core_pair_offers (code_tag, expires_at);

-- Every typed-code try that got past the attestation, right or wrong, with its caller (as on
-- core_mobile_nonces), for the hourly caps per caller and across the factory.
CREATE TABLE core_pair_code_tries (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  caller TEXT NOT NULL DEFAULT ''
);
CREATE INDEX core_pair_code_tries_at_idx ON core_pair_code_tries (at);
CREATE INDEX core_pair_code_tries_caller_idx ON core_pair_code_tries (caller, at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 310) WHERE key = 'schema_version';
