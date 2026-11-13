-- Dark factory mode (spec 52 (e), reviews of #152): the factory's own project is marked as the
-- factory's source explicitly, so default-deny never depends on detecting it. A column, not a key in
-- the project's config: the engine running while this migrates (before its own deploy) reads configs
-- with a strict schema and would refuse a key it doesn't know. 1: the factory's own source (always
-- default-deny, whatever the config says); null: decided by the config's `factorySource` (`auto`
-- detects it). Read with the project's row, never filtered on: no index. Nothing to retain.
ALTER TABLE core_projects ADD COLUMN factory_source INTEGER;
UPDATE core_projects SET factory_source = 1
WHERE id IN (SELECT project_id FROM core_repositories WHERE name = 'software-factory');

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 286) WHERE key = 'schema_version';
