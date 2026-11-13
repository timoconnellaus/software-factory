-- Migration 0394 (spec 53, ADR 0582 amended; #190 review): the merge commit the merge queue made.
--
-- The queue merges the default branch into an approved head itself (POST /merges, synchronous) and
-- records the SHA GitHub returns. Only that exact commit is accepted as the update: an identity
-- fingerprint (author, committer, signature, parents) is forgeable by any token of the same App.
-- Cleared with update_from_sha and update_base_sha once the update is accepted or answered.
-- Read by mergeQueue.update with the entry's own row (by primary key): no index.
ALTER TABLE core_merge_queue ADD COLUMN update_merge_sha TEXT;
