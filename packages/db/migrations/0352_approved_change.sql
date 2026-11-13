-- Migration 0352 (spec 53, ADR 0582): the change a merge approval is about. The digest of the PR's
-- change when it was approved: every path whose mode or blob differs between the head and its
-- merge base with the default branch, with both sides' mode and blob (from git trees, never patch
-- text). A merge of the default branch keeps the approval only while the digest is the same. Null
-- when it couldn't be read in full (a truncated tree, an error): a null never matches, so a merge
-- of main then withdraws the approval (fail closed).
ALTER TABLE core_merge_queue ADD COLUMN approved_digest TEXT;
-- The update the queue asked GitHub for (spec 53 review): the head it asked to update from and the
-- default branch's head when it asked. Only that merge, made by GitHub, is accepted as the update.
ALTER TABLE core_merge_queue ADD COLUMN update_from_sha TEXT;
ALTER TABLE core_merge_queue ADD COLUMN update_base_sha TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 352) WHERE key = 'schema_version';
