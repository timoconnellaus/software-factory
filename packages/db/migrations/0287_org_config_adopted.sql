-- Spec 52, Q3 (review of #139, #185): "adopt only the tightened parts". A running item stays on the
-- org config version it pinned (`org_config_version`) and, when a newer version both tightens and
-- loosens, takes only that version's tightenings, stage by stage. `org_config_adopted` lists, in
-- order, the newer versions whose tightenings it took (a JSON array of version numbers, at most 8):
-- its workflow is the pinned one with each folded in, so a later version that drops what an earlier
-- one added never takes it away. Null: none. Read with the item's row (by primary key), never
-- filtered on; no index. One column on an existing row: nothing to retain.
ALTER TABLE core_work_items ADD COLUMN org_config_adopted TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 287) WHERE key = 'schema_version';
