-- Migration 0271: a check the runner could not run (ADR 0501, third review, B3). No isolated exec on
-- that runner, a job with no container, a sandbox that could not start: the host reports the check
-- "not run" with why. It is stored as such, never as a failure (it is not one the build can fix)
-- and never as a pass: the item goes on to verify and the merge gate, where a person decides.
ALTER TABLE core_check_results ADD COLUMN not_run TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 271) WHERE key = 'schema_version';
