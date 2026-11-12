-- The reconciler in shadow (spec 52 PR (c), ADR 0511): beside today's Workflow, it records what it
-- would have done at each stage transition, next to what the Workflow did. It drives nothing.
-- core_item_stages / core_item_steps, reconcile_rev and next_check_at come with the switch-over,
-- when the reconciler drives items; in shadow nothing would write them.

-- One row per transition the Workflow made: what it did and what the reconciler predicted.
CREATE TABLE core_reconcile_shadow (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  -- Order within the item.
  seq INTEGER NOT NULL,
  observed TEXT NOT NULL,
  predicted TEXT NOT NULL,
  agrees INTEGER NOT NULL CHECK (agrees IN (0, 1)),
  created_at TEXT NOT NULL
);
-- reconcile.report: an item's rows in order. Pruning: oldest first.
CREATE INDEX core_reconcile_shadow_item_idx ON core_reconcile_shadow (work_item_id, seq);
CREATE INDEX core_reconcile_shadow_created_idx ON core_reconcile_shadow (created_at);

-- One row per item that reached Done under shadow: how many transitions, how many diverged. The
-- agreement streak is the run of finished items with none, newest first.
CREATE TABLE core_reconcile_items (
  work_item_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  transitions INTEGER NOT NULL,
  divergences INTEGER NOT NULL,
  finished_at TEXT NOT NULL
);
-- reconcile.streak: an org's last finished items. Pruning: oldest first.
CREATE INDEX core_reconcile_items_org_idx ON core_reconcile_items (org_id, finished_at);
CREATE INDEX core_reconcile_items_finished_idx ON core_reconcile_items (finished_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 281) WHERE key = 'schema_version';
