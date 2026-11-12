-- A shaped item flagged at release (spec 52, Q4): the org workflow's shaping stages changed since it
-- was shaped, so release doesn't guess. `release_flag` is the marker, like `needs_info` (migration
-- 0370): JSON `{ reason, shapedUnder, current, flaggedBy, byAgent, at }`. `release_flag_user_id` is
-- the person who must choose (the one who released it; for an agent's release, the requester or the
-- first approver): inbox.list reads that person's flagged items by the partial index below
-- (`WHERE release_flag_user_id = ?`). Both are cleared when the person chooses. No retention: one
-- marker per item, cleared on the choice.
ALTER TABLE core_work_items ADD COLUMN release_flag TEXT;
ALTER TABLE core_work_items ADD COLUMN release_flag_user_id TEXT;
CREATE INDEX core_work_items_release_flag_idx ON core_work_items (release_flag_user_id)
  WHERE release_flag_user_id IS NOT NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 285) WHERE key = 'schema_version';
