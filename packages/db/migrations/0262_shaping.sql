-- Migration 0262 (spec 50 part C, ADR 0493): shaping stages run before release. When a person asks
-- for an item to be shaped, its Workflow starts while it is still unreleased: triage and interview
-- planning (the spec stage and its gate) run, the item becomes ready, and the Workflow waits for the
-- release. `shaping_started_at` says its Workflow already exists, so the pull wakes it instead of
-- creating one.
ALTER TABLE core_work_items ADD COLUMN shaping_started_at TEXT;
-- When the shaping stages finished, and the default branch's head then: what the plan was written
-- against, so release can say how far the branch has moved since.
ALTER TABLE core_work_items ADD COLUMN shaped_at TEXT;
ALTER TABLE core_work_items ADD COLUMN shaped_base_sha TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 262) WHERE key = 'schema_version';
