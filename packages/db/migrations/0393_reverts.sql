-- Migration 0393 (spec 53 §5, decisions 2 and 5, ADR 0584): the engine's reverts of a red main's
-- culprit. One row per revert: the revert's own work item (an attached PR, marked as a repair), the
-- item it reverts, and the "Reland: <title>" backlog item made once the revert has merged. Few rows
-- (one per culprit reverted): kept as the record of what was reverted, ADR 0622 says why.
CREATE TABLE core_reverts (
  revert_work_item_id TEXT PRIMARY KEY NOT NULL REFERENCES core_work_items (id),
  original_work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  repository_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- The open episode it was made for (core_main_health.red_since when it was made).
  red_since TEXT NOT NULL,
  reland_work_item_id TEXT,
  created_at TEXT NOT NULL
);
-- mainRed.revert's "already reverted?": `WHERE original_work_item_id = ?`.
CREATE INDEX core_reverts_original_idx ON core_reverts (original_work_item_id);
-- The minute cron's reland step: reverts with no reland yet (partial: a handful at most).
CREATE INDEX core_reverts_reland_idx ON core_reverts (created_at) WHERE reland_work_item_id IS NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 393) WHERE key = 'schema_version';
