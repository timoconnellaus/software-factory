-- Workflows and agents (ADR 0371, 0372, spec 09 M2). A work item records the workflow triage
-- picked (null: the skeleton alone), and why; a job records the model tier its agent asked for.
ALTER TABLE core_work_items ADD COLUMN workflow TEXT;
ALTER TABLE core_work_items ADD COLUMN workflow_reason TEXT;
-- standard | light (ADR 0372); null is standard.
ALTER TABLE core_jobs ADD COLUMN tier TEXT;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 141) WHERE key = 'schema_version';
