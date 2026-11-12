-- A run's archived log that is lost (an object the chunk index names, gone from sf-archive) is an
-- incident for a person, not one that starts an agent's fix: nothing an agent does can bring the
-- object back. `archive_missing` is that kind (run.reportArchiveMissing, the archive's daily
-- sample). SQLite can't change a CHECK, so the table is rebuilt; nothing references it.
CREATE TABLE core_incidents_new (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_work_item_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sent_back', 'run_failed', 'run_stalled', 'manual', 'archive_missing')),
  reason TEXT NOT NULL,
  fix_work_item_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  root_cause TEXT,
  proposed_fix TEXT
);
INSERT INTO core_incidents_new (id, org_id, project_id, source_work_item_id, run_id, kind, reason,
  fix_work_item_id, created_by, created_at, root_cause, proposed_fix)
SELECT id, org_id, project_id, source_work_item_id, run_id, kind, reason,
  fix_work_item_id, created_by, created_at, root_cause, proposed_fix
FROM core_incidents;
DROP TABLE core_incidents;
ALTER TABLE core_incidents_new RENAME TO core_incidents;
CREATE INDEX core_incidents_project_idx ON core_incidents (project_id, created_at);

-- Read by run.reportArchiveMissing and run.live (only when the archive read came back `missing`):
-- the run's archive incident, one per run (`WHERE run_id = ? AND kind = 'archive_missing'`).
CREATE INDEX core_incidents_run_idx ON core_incidents (run_id, kind) WHERE run_id IS NOT NULL;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 364) WHERE key = 'schema_version';
