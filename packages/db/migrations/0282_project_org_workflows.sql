-- Projects on org workflows (spec 52 PR (d), ADR 0510). A project's config names an org workflow by
-- id (`workflow: "wf_…"`) with its overrides (`workflowOverrides`); both live in the config document,
-- so they need no column. A work item pins the org config version it runs that workflow under, next
-- to the project config it pins (`policy_sha`): when shaping starts and again at the pull (release
-- takes the current version, Q4). A later org save never moves a running item onto a looser version.
-- Read with the item's row by primary key; no index.
ALTER TABLE core_work_items ADD COLUMN org_config_version INTEGER;

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 282) WHERE key = 'schema_version';
