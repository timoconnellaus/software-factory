-- Retention of the tables that only grew (AGENTS.md "Cloudflare cost", rule 3). The minute cron
-- prunes them in bounded batches (apps/engine/src/retention.ts); each index below is the time
-- column a prune reads, so a prune with nothing due reads nothing.

-- A batch of log lines is stored as one row (seq is its first line's, last_seq its last's, the
-- payload { lines: [...] }) instead of a row per line: about 2 rows written per batch, not 2 per
-- line. Other events stay a row each. Rows written before this keep last_seq NULL.
ALTER TABLE core_run_events ADD COLUMN last_seq INTEGER;

-- (A run's events and steers are archived with their read path in the next migration.)

-- Intake events are kept forever as the dedupe of a source's event ids (a late redelivery must
-- find its event, not be "attached" again); their body, which nothing reads, is cleared after 90
-- days. The partial index holds only rows whose body is still there.
CREATE INDEX core_intake_events_body_idx ON core_intake_events (received_at) WHERE body != '';

-- Device codes and GitHub connect states are deleted a day after they expire.
CREATE INDEX core_runner_device_codes_expires_idx ON core_runner_device_codes (expires_at);
CREATE INDEX core_cli_device_codes_expires_idx ON core_cli_device_codes (expires_at);
CREATE INDEX core_github_connect_states_expires_idx ON core_github_connect_states (expires_at);

-- Terminal attaches are deleted 90 days after they opened (the audit keeps each attach).
CREATE INDEX core_run_terminal_attaches_opened_idx ON core_run_terminal_attaches (opened_at);

-- core_connector_events already has core_connector_events_at_idx (received_at).

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 361) WHERE key = 'schema_version';
