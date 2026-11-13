-- Migration 0392 (spec 53 decision 1, reviews of #158 and #175): what the babysitter's conflict
-- resolution changed, so the person at the reopened merge gate sees only the resolution.
--
-- Its own table, not a column on core_work_items (whose every selectAll would carry the patches):
-- one row per work item, for the head it was read on, replaced by the next resolution and deleted
-- by the hourly prune once the item has ended (`pruneBabysit`). `summary` is small JSON (status,
-- the files with their flags, the counts not shown) and is what workItem.get returns while the
-- item's head is `head_sha`; `patches` (JSON path → clipped patch, up to about 200 KB) is read only
-- on demand (`babysit.resolutionPatches`).
CREATE TABLE core_babysit_resolutions (
  work_item_id TEXT PRIMARY KEY NOT NULL REFERENCES core_work_items (id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  patches TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 392) WHERE key = 'schema_version';
