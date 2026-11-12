-- Factory config lives in the app as versions (ADR 0370, spec 09 M1). Versions reuse
-- core_project_policies: an app version's key is `v<N>` in `sha`, so every reader that joins on
-- core_projects.policy_sha keeps working. Rows read from git before this migration stay, keyed by
-- their commit SHA, so audit rows and work items that recorded them still resolve.
ALTER TABLE core_project_policies ADD COLUMN version INTEGER;
-- app | import | migrated | improver | rollback
ALTER TABLE core_project_policies ADD COLUMN source TEXT;
ALTER TABLE core_project_policies ADD COLUMN created_by TEXT;
ALTER TABLE core_project_policies ADD COLUMN note TEXT;
ALTER TABLE core_project_policies ADD COLUMN parent_version INTEGER;
CREATE UNIQUE INDEX core_project_policies_version_idx
  ON core_project_policies (project_id, version) WHERE version IS NOT NULL;

-- Each project's policy in force becomes version 1.
INSERT INTO core_project_policies
  (project_id, sha, ref, raw, valid, error, received_at, version, source, created_by, note, parent_version)
SELECT pp.project_id, 'v1', 'app', pp.raw, pp.valid, pp.error, pp.received_at, 1, 'migrated', NULL,
       'From .factory/policy.json at ' || pp.sha, NULL
FROM core_project_policies pp
JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha;

UPDATE core_projects SET policy_sha = 'v1'
WHERE policy_sha IS NOT NULL
  AND EXISTS (SELECT 1 FROM core_project_policies pp WHERE pp.project_id = core_projects.id AND pp.sha = 'v1');

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 140) WHERE key = 'schema_version';
