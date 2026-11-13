-- Migration 0392 (spec 53 decision 1, review of #158): what the babysitter's conflict resolution
-- changed, so the person at the reopened merge gate sees only the resolution. JSON `{ sha,
-- itemHead, main, files: [{ path, conflicted, patch }], outside: [path] }`: the files whose content
-- in the resolution's merge commit is neither side's, whether both sides had changed them (the
-- conflict), each one's patch against the item's head (clipped), and the ones outside the conflicted
-- set (flagged). Set by `babysit.resolution`; one per item, replaced by the next resolution: no
-- new rows.
ALTER TABLE core_work_items ADD COLUMN babysit_resolution TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 392) WHERE key = 'schema_version';
