-- Dark factory mode (spec 52 (e), review of #152): the factory's own project is marked as the
-- factory's source explicitly, so default-deny never depends on detecting it. Its current config
-- version gets `factorySource: "yes"` (a tightening: on that repository auto-approval covers only
-- the allow-list in code). The project is the one whose repository is the factory's own
-- (`software-factory`). A config written later through the app keeps the field; saying "no" is a
-- loosening an org admin approves. No new table: nothing to retain.
UPDATE core_project_policies
SET raw = json_set(raw, '$.factorySource', 'yes')
WHERE json_valid(raw)
  AND (project_id, sha) IN (
    SELECT p.id, p.policy_sha FROM core_projects p
    JOIN core_repositories r ON r.project_id = p.id
    WHERE r.name = 'software-factory' AND p.policy_sha IS NOT NULL
  );

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 286) WHERE key = 'schema_version';
