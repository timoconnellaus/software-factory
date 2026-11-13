-- Migration 0391 (spec 53 part e, ADR 0584): who turned main red.
--
-- The merge commit each factory landing made (pr.merge's answer), so an episode's suspects are the
-- factory's own landings and the one that turned main red can be proven, not guessed. Kept with
-- the item (no new rows).
ALTER TABLE core_work_items ADD COLUMN merge_sha TEXT;

-- When the default branch was last seen green (the suspects are the landings after it), the
-- episode's suspects (JSON [{workItemId, number, title, prNumber, mergeSha}], at most 20, fixed
-- when it opens), and its culprit with why: named in code only when it is provable (one landing,
-- and its merge commit is the first red head on top of the last green one), or by a person
-- (`mainRed.attribute`). Never a guess. One row per repository: no growth.
ALTER TABLE core_main_health ADD COLUMN green_at TEXT;
ALTER TABLE core_main_health ADD COLUMN suspects TEXT NOT NULL DEFAULT '[]';
ALTER TABLE core_main_health ADD COLUMN culprit_work_item_id TEXT;
ALTER TABLE core_main_health ADD COLUMN attribution TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 391) WHERE key = 'schema_version';
