-- Spec 44 part A (Durable Objects never held awake): the runner host's held `steers` and `terminal`
-- calls wait in the Worker, polling a cheap indexed read every HELD_POLL_MS (3 s), instead of
-- holding the work item's PlanningHub or the job's TerminalRelay in memory.

-- Read by the held steer call's poll (apps/engine/src/channel.ts, steerReply):
-- `SELECT 1 FROM core_run_steers WHERE run_id = ? AND delivered_at IS NULL LIMIT 1`. Partial, so it
-- holds only the queued steers (a handful) and the poll reads nothing while none is queued.
CREATE INDEX core_run_steers_undelivered_idx ON core_run_steers (run_id) WHERE delivered_at IS NULL;

-- Read by the held terminal call's poll (terminalReply):
-- `SELECT opened_at FROM core_run_terminal_attaches WHERE run_id = ? AND closed_at IS NULL LIMIT 1`,
-- and by run.terminal.closeStale. Partial: only the open attaches (a viewer or two while someone
-- watches), so the poll reads nothing while nobody does.
CREATE INDEX core_run_terminal_attaches_open_idx ON core_run_terminal_attaches (run_id, opened_at)
  WHERE closed_at IS NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 367) WHERE key = 'schema_version';
