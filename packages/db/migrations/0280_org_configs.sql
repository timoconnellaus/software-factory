-- Org config versions (spec 52 PR (b), ADR 0510): an org's workflows and agents, defined once and
-- used by its projects. Same machinery as a project's config (ADR 0370): versions written only
-- through operations, validated before save, a loosening save waits for an org admin. Projects keep
-- running their own config until spec 52 PR (d) points them at an org workflow.
CREATE TABLE core_org_configs (
  org_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  -- The document, pretty JSON. Only valid documents are ever written.
  raw TEXT NOT NULL,
  -- app | import | migrated | rollback
  source TEXT NOT NULL,
  created_by TEXT,
  note TEXT,
  parent_version INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, version)
);

-- The org's current version; null until its first save.
ALTER TABLE core_organization ADD COLUMN config_version INTEGER;

-- orgConfig.get's pending org config saves: an indexed read per org, not every org's pending actions.
CREATE INDEX core_pending_actions_org_idx ON core_pending_actions (org_id, status, created_at);

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 280) WHERE key = 'schema_version';
