-- Spec 44, host ack (review of #179): a runner host that acks (its steer call sends `ack`) is
-- offered queued steers rather than handed them. `offered_until` is when the offer lapses: until
-- then no other take gets the steer; after it, an unacked steer (taken by a call whose host had
-- gone) is offered again. `delivered_at` is set only when the host acks. A host that doesn't ack
-- is handed steers as before (delivered_at at the take) and never sets this. Read with the row
-- (core_run_steers_undelivered_idx finds the run's queued steers; this filters among them).
ALTER TABLE core_run_steers ADD COLUMN offered_until TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 369) WHERE key = 'schema_version';
