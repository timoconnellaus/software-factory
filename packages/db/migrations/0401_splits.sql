-- Migration 0401 (block AU): a plan splits a work item (spec 24, ADR 0303, 0630).
-- The children a spec version proposes, as JSON [{key, title, size, goal, scope, acceptanceCriteria,
-- after?}]: created when that version is approved. Null: no split. Kept with the spec row, like the
-- rest of the planning record.
ALTER TABLE core_specs ADD COLUMN children TEXT;

-- A parent's children: read when a child ends (are all of them done or cancelled? which siblings
-- wait for it?), when the parent's PR merges (release them), and by the work list to group them.
-- Each read filters on parent_work_item_id and is bounded by the split's 8 children.
CREATE INDEX core_work_items_parent_idx
  ON core_work_items (parent_work_item_id, status)
  WHERE parent_work_item_id IS NOT NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 401) WHERE key = 'schema_version';
