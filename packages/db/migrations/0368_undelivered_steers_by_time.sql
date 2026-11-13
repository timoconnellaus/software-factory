-- Spec 44, review of #172: one partial index serves both readers of queued steers.
-- - The held steer call's poll (apps/engine/src/channel.ts): `SELECT 1 FROM core_run_steers WHERE
--   run_id = ? AND delivered_at IS NULL LIMIT 1`.
-- - run.takeSteers: `... WHERE run_id = ? AND delivered_at IS NULL ORDER BY created_at LIMIT 20`,
--   which read every steer of the run through core_run_steers_run_idx before.
-- Partial, so it holds only the queued steers (a handful), not the run's delivered history.
DROP INDEX IF EXISTS core_run_steers_undelivered_idx;
CREATE INDEX core_run_steers_undelivered_idx ON core_run_steers (run_id, created_at)
  WHERE delivered_at IS NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 368) WHERE key = 'schema_version';
