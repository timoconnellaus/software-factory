-- Migration 0272 (ADR 0501, fourth review): where each check ran, and the index the periodic prune
-- of core_check_results walks.
--
-- `isolation`: `container` (a fresh check container), `sandbox` (the OS sandbox of a Linux runner),
-- `weaker-sandbox` (the OS sandbox of a Mac runner whose owner opted in: a process a check leaves
-- can outlive it, so the merge gate says so). NULL for results from before, and for checks not run.
ALTER TABLE core_check_results ADD COLUMN isolation TEXT;

-- The prune (apps/engine, hourly): results are evidence for the merge gate, kept while their item
-- is open and for 30 days after it ends; the prune walks the oldest rows by `created_at`, at most
-- 500 at a time.
CREATE INDEX core_check_results_created_idx ON core_check_results (created_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 272) WHERE key = 'schema_version';
