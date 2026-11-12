-- Retention of the tables that only grew (AGENTS.md "Cloudflare cost", rule 4). The minute cron
-- prunes them in bounded batches (apps/engine/src/retention.ts); each index below is the time
-- column a prune reads, so a prune with nothing due reads nothing.

-- A run's events and steers go to R2 (sf-archive) 30 days after it ended, then leave D1. The
-- partial index holds only runs still to archive, so it empties as they are archived.
ALTER TABLE core_runs ADD COLUMN events_archived_at TEXT;
CREATE INDEX core_runs_archive_due_idx ON core_runs (ended_at)
  WHERE ended_at IS NOT NULL AND events_archived_at IS NULL;

-- Intake events (the dedupe of a source's event ids) are deleted after 90 days.
CREATE INDEX core_intake_events_received_idx ON core_intake_events (received_at);

-- Device codes and GitHub connect states are deleted a day after they expire.
CREATE INDEX core_runner_device_codes_expires_idx ON core_runner_device_codes (expires_at);
CREATE INDEX core_cli_device_codes_expires_idx ON core_cli_device_codes (expires_at);
CREATE INDEX core_github_connect_states_expires_idx ON core_github_connect_states (expires_at);

-- Terminal attaches are deleted 90 days after they opened (the audit keeps each attach).
CREATE INDEX core_run_terminal_attaches_opened_idx ON core_run_terminal_attaches (opened_at);

-- core_connector_events already has core_connector_events_at_idx (received_at).

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 361) WHERE key = 'schema_version';
