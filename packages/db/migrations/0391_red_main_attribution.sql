-- Migration 0391 (spec 53 part e, ADR 0621): who turned main red.
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
-- Who named the culprit: `proven` (code: one landing, its merge commit the first red head, and the
-- red reproduced on a rerun of the failing checks), `person`, or `agent` (the repository's babysit
-- job, through the deliverer). A weaker one never overwrites a stronger one.
ALTER TABLE core_main_health ADD COLUMN attributed_by TEXT
  CHECK (attributed_by IS NULL OR attributed_by IN ('proven', 'person', 'agent'));
-- A single-landing episode's candidate culprit while its failing checks are rerun once on the red
-- head: proven only if they fail again.
ALTER TABLE core_main_health ADD COLUMN candidate_work_item_id TEXT;

-- When `factory/verify` on a head was set to held (spec 53, decision 7); null when it isn't. The
-- cron's release sweep reads only held rows: `WHERE held_at IS NOT NULL AND (release_after IS NULL
-- OR release_after <= ?) ORDER BY release_after LIMIT 20`, through the partial index below, so it
-- never reads the verify checks of heads that were never held. A held row it couldn't release backs
-- off (`release_attempts`, `release_after`), oldest attempt first, so one that keeps failing never
-- starves the rest.
ALTER TABLE core_verify_checks ADD COLUMN held_at TEXT;
ALTER TABLE core_verify_checks ADD COLUMN release_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core_verify_checks ADD COLUMN release_after TEXT;
CREATE INDEX core_verify_checks_held_idx ON core_verify_checks (release_after)
  WHERE held_at IS NOT NULL;

-- recheckHeads' merge gates (main.observe, once per episode opening or closing): `WHERE project_id
-- = ? AND kind = 'merge' AND status = 'pending'` joined to the item for its repository. Partial: only
-- open merge gates, and only the project's.
CREATE INDEX core_pending_actions_open_merge_idx ON core_pending_actions (project_id)
  WHERE kind = 'merge' AND status = 'pending';

-- The check run a rerun replaced: proof needs a newer run, not only a later time.
ALTER TABLE core_ci_reruns ADD COLUMN check_run_id TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 391) WHERE key = 'schema_version';
