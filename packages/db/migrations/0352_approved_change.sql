-- Migration 0352 (spec 53, ADR 0582): the change a merge approval is about. The digest of the PR's
-- diff against the default branch when it was approved (paths and added and removed lines); a merge
-- of the default branch into the branch keeps the approval only while the digest is the same. Null
-- when GitHub left a patch out (the parent rule of ADR 0330 decides alone) or for older entries.
ALTER TABLE core_merge_queue ADD COLUMN approved_digest TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 352) WHERE key = 'schema_version';
