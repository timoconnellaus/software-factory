-- Migration 0400 (block AU): design previews (spec 22 part B). The preview the runner's checks drew
-- of a design revision, as JSON {svg, width, height, parts, warnings, sha256}: the app shows the SVG
-- as an image with each part's box, and the write-back commits it beside the design. Null for other
-- kinds, for a design saved by a runner without the checks, and for a pulled file that won't draw.
-- It counts in the revision's `size`, so the item's byte budget and revision pruning already cover
-- it: no new table and no index (read only by the revisions' primary key).
ALTER TABLE core_planning_artifact_revisions ADD COLUMN preview TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 400) WHERE key = 'schema_version';
