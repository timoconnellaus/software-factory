-- Migration 0393 (spec 53 §5, decisions 2 and 5, ADR 0622): the engine's reverts of a red main's
-- culprit.
--
-- One row per claim: the culprit and the episode (unique together, so a cron pass and a person
-- can't both open a revert PR), committed before GitHub is asked; then the revert PR and its work
-- item (an attached PR marked as a repair) once GitHub made it, whether it is the exact inverse of
-- the culprit's merge (checked in code), and the "Reland: <title>" item once the revert merged.
--   claimed   committed, GitHub not asked yet (or asked and not recorded: the PR is looked up)
--   opened    the revert PR is open, as `revert_work_item_id`
--   failed    GitHub couldn't revert (`reason`): not tried again for this episode
--   abandoned the revert item ended without merging
--   relanded  merged, and its reland item made (or the cap reached, `reason`)
-- Few rows (one per culprit claimed); kept as the record of what was reverted (ADR 0622).
CREATE TABLE core_reverts (
  id TEXT PRIMARY KEY NOT NULL,
  original_work_item_id TEXT NOT NULL REFERENCES core_work_items (id),
  repository_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  red_since TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('claimed', 'opened', 'failed', 'abandoned', 'relanded')),
  revert_pr_number INTEGER,
  revert_work_item_id TEXT REFERENCES core_work_items (id),
  -- 1 when the revert PR's tree equals the culprit's first parent on every path the culprit
  -- changed, and it changes nothing else (revertVerdict's "the engine's unchanged revert").
  exact_inverse INTEGER,
  reason TEXT,
  reland_work_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The claim (mainRed.revert's insert) and "already reverted?" (`WHERE original_work_item_id = ?`,
-- the prefix): one per culprit per episode.
CREATE UNIQUE INDEX core_reverts_claim_idx ON core_reverts (original_work_item_id, red_since);
-- mainRed.reland's lookup of a revert item, and "is this item a revert?".
CREATE UNIQUE INDEX core_reverts_revert_idx ON core_reverts (revert_work_item_id)
  WHERE revert_work_item_id IS NOT NULL;
-- The minute cron's reland and abandon step: only open reverts (partial: a handful at most; a
-- revert leaves it when it relands, fails or is abandoned).
CREATE INDEX core_reverts_open_idx ON core_reverts (created_at) WHERE status = 'opened';

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 393) WHERE key = 'schema_version';
