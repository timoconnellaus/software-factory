-- Migration 0180 (Claude accounts on a host, ADR 0410): what each runner last reported about its
-- Claude accounts (names, the active one, usage limits; never a credential), and the account its
-- owner asked it to switch to, until the runner reports that account active.
ALTER TABLE core_runners ADD COLUMN accounts TEXT;
ALTER TABLE core_runners ADD COLUMN account_requested TEXT;
ALTER TABLE core_runners ADD COLUMN account_requested_at TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 180) WHERE key = 'schema_version';
