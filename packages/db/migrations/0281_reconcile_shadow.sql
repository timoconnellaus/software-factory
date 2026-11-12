-- The reconciler in shadow (spec 52 PR (c), ADR 0511): beside today's Workflow, it records what it
-- would have done over each ended item's stage history. It drives nothing, and it writes nothing on
-- the Workflow's path: sf-engine's shadow pass reads the `workItem.finish` and `workItem.cancel`
-- audit rows after its cursor (`core_meta` key `reconcile_shadow_cursor`, by
-- core_audit_operation_idx) and writes one row per ended item.
-- core_item_stages / core_item_steps, reconcile_rev and next_check_at come with the switch-over,
-- when the reconciler drives items; in shadow nothing would write them.

-- One row per ended item: how it ended, its transitions compared, and its divergences (disagreeing
-- transitions plus every aspect not yet compared). `report` is the verdict as JSON.
CREATE TABLE core_reconcile_items (
  work_item_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  -- done | failed | rejected | cancelled
  ended TEXT NOT NULL,
  transitions INTEGER NOT NULL,
  divergences INTEGER NOT NULL,
  report TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
-- reconcile.streak: an org's last ended items. Pruning: oldest first.
CREATE INDEX core_reconcile_items_org_idx ON core_reconcile_items (org_id, finished_at);
CREATE INDEX core_reconcile_items_finished_idx ON core_reconcile_items (finished_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 281) WHERE key = 'schema_version';
