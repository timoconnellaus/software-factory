-- Spec 44, host ack follow-ups (review of #189).
-- `offers`: how many times run.takeSteers has offered the steer to an acking host. A host that opts
-- in and never acks would otherwise be offered it again every STEER_OFFER_MS for the run's life,
-- each time with a write and an audit row; at the cap the take gives up instead. Read with the row
-- the take already reads (core_run_steers_undelivered_idx).
ALTER TABLE core_run_steers ADD COLUMN offers INTEGER NOT NULL DEFAULT 0;
-- `undeliverable_at`: when the take gave up. `delivered_at` is set too, so the steer leaves the
-- queue (and the partial index); run.live shows it as undelivered and its author is told.
ALTER TABLE core_run_steers ADD COLUMN undeliverable_at TEXT;
-- run.takeSteers' delivery of an acked planning steer's chat message:
-- `UPDATE core_planning_messages SET delivered_at = ? WHERE steer_id IN (...) AND delivered_at IS NULL`,
-- which scanned the whole table. Partial: only a steer's messages (a few), not the chat.
CREATE INDEX core_planning_messages_steer_idx ON core_planning_messages (steer_id)
  WHERE steer_id IS NOT NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 410) WHERE key = 'schema_version';
