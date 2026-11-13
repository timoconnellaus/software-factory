-- Skills (spec 52 build step (f), ADR 0513): how the team does one thing, written once, owned by the
-- org. Each save or proposal is a version here; the org config version (core_org_configs) names the
-- current version of each skill and where it is attached, so an item that pins its org config
-- version pins its skills too.
--
-- `status`: `current` (a version an org config has pointed at), `proposed` (the factory's candidate,
-- waiting for a person), `rejected`. Read by primary key (a job's skill, an org config's current
-- version) and by the primary key's prefix (`skill.get`'s history, LIMIT 50; `skill.list`'s
-- proposals by `core_skill_versions_status_idx`).
--
-- Retention: versions are config history, kept like core_org_configs (ADR 0370): a pinned item may
-- still read an old one. They grow only by a person's save or the factory's proposal, at most 500
-- versions a skill (the handler refuses more), and are deleted with the org.
CREATE TABLE core_skill_versions (
  org_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  -- sha256 of the body, hex: what a run records it followed.
  sha256 TEXT NOT NULL,
  -- JSON `{ builtin, mode }` when it changes a stage type's built-in skill; null otherwise.
  overrides TEXT,
  -- JSON `{ incidentId?, workItemId?, note? }`: where it came from.
  provenance TEXT,
  status TEXT NOT NULL CHECK (status IN ('current', 'proposed', 'rejected')),
  source TEXT NOT NULL,
  created_by TEXT,
  note TEXT,
  parent_version INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, skill_id, version)
);
-- skill.list's open proposals for an org: WHERE org_id = ? AND status = 'proposed'.
CREATE INDEX core_skill_versions_status_idx ON core_skill_versions (org_id, status)
  WHERE status = 'proposed';

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 283) WHERE key = 'schema_version';
