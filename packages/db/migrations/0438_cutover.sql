-- Cutover (spec 70, milestone 5; ADR 0660): the old software pipeline is deleted, and with it every
-- table only it read or wrote. The owner decided nobody uses it, so its data goes too: this
-- migration destroys data and can't be undone. Kept, because the platform or the new core reads
-- them: sign-in and orgs (core_user, core_session, core_account, core_verification,
-- core_organization, core_member, core_invitation), the doors' devices and tokens
-- (core_cli_device_codes, core_cli_tokens, core_desktop_auth_requests, core_desktop_devices,
-- core_presence_challenges, core_mobile_nonces, core_pair_offers, core_pair_code_tries), runners
-- (core_runners, core_runner_shares, core_runner_device_codes), the GitHub connection
-- (core_github_installations, core_github_connect_states), the runner channel's idempotency store
-- (core_channel_requests), the audit journal (core_audit), the outbox (core_outbox), batch guards
-- (core_batch_guard), core_meta (the schema version), and every flow_ table.

-- The audit journal stays append-only, now with no exception: its archive (ADR 0591) is deleted, so
-- no row is ever archived and the archive's delete exception goes. What still writes the journal is
-- the platform's operations, a few rows a day per person and runner (a heartbeat or claim writes
-- one only when the runner's state changed, ADR 0590), so it is kept without a prune.
-- The plain trigger is created before the archive's is dropped, so there is no moment with neither.
CREATE TRIGGER core_audit_no_delete BEFORE DELETE ON core_audit
BEGIN SELECT RAISE(ABORT, 'core_audit is append-only'); END;
DROP TRIGGER IF EXISTS core_audit_delete_archived_only;
-- It served the old core's per-item audit reads; nothing reads it now (AGENTS.md cost rule 4).
DROP INDEX IF EXISTS core_audit_item_idx;

-- Children before parents, so no drop leaves a dangling foreign key. A table's indexes and
-- triggers go with it.
DROP TABLE IF EXISTS core_adjudications;
DROP TABLE IF EXISTS core_artifacts;
DROP TABLE IF EXISTS core_attachments;
DROP TABLE IF EXISTS core_audit_archive_chunks;
DROP TABLE IF EXISTS core_audit_archive_items;
DROP TABLE IF EXISTS core_audit_archive_leases;
DROP TABLE IF EXISTS core_audit_archives;
DROP TABLE IF EXISTS core_babysit_resolutions;
DROP TABLE IF EXISTS core_check_results;
DROP TABLE IF EXISTS core_ci_reruns;
DROP TABLE IF EXISTS core_config_trials;
DROP TABLE IF EXISTS core_connector_events;
DROP TABLE IF EXISTS core_delivery_state;
DROP TABLE IF EXISTS core_main_health;
DROP TABLE IF EXISTS core_merge_queue;
DROP TABLE IF EXISTS core_override_approvals;
DROP TABLE IF EXISTS core_project_policies;
DROP TABLE IF EXISTS core_project_protection;
DROP TABLE IF EXISTS core_verify_checks;
DROP TABLE IF EXISTS core_intake_events;
DROP TABLE IF EXISTS core_intake_keys;
DROP TABLE IF EXISTS core_run_archive_chunks;
DROP TABLE IF EXISTS core_run_archive_leases;
DROP TABLE IF EXISTS core_run_events;
DROP TABLE IF EXISTS core_run_steers;
DROP TABLE IF EXISTS core_run_terminal_attaches;
DROP TABLE IF EXISTS core_runs;
DROP TABLE IF EXISTS core_jobs;
DROP TABLE IF EXISTS core_leases;
DROP TABLE IF EXISTS core_planning_artifact_revisions;
DROP TABLE IF EXISTS core_planning_artifacts;
DROP TABLE IF EXISTS core_planning_events;
DROP TABLE IF EXISTS core_planning_messages;
DROP TABLE IF EXISTS core_planning_presence;
DROP TABLE IF EXISTS core_planning_sessions;
DROP TABLE IF EXISTS core_questions;
DROP TABLE IF EXISTS core_reverts;
DROP TABLE IF EXISTS core_review_packets;
DROP TABLE IF EXISTS core_spec_edits;
DROP TABLE IF EXISTS core_specs;
DROP TABLE IF EXISTS core_stages;
DROP TABLE IF EXISTS core_work_item_links;
DROP TABLE IF EXISTS core_work_items;
DROP TABLE IF EXISTS core_repositories;
DROP TABLE IF EXISTS core_projects;
DROP TABLE IF EXISTS core_factories;
DROP TABLE IF EXISTS core_flake_fixes;
DROP TABLE IF EXISTS core_flakes;
DROP TABLE IF EXISTS core_incidents;
DROP TABLE IF EXISTS core_kill_switches;
DROP TABLE IF EXISTS core_org_configs;
DROP TABLE IF EXISTS core_pending_actions;
DROP TABLE IF EXISTS core_reconcile_items;
DROP TABLE IF EXISTS core_skill_versions;

-- The old core's cursors and settings in core_meta (the shadow reconciler's, the check results'
-- prune, the archive's state); the schema version stays.
DELETE FROM core_meta WHERE key != 'schema_version';
-- Outbox rows for the old core's Workflows and queues, which nothing delivers any more.
DELETE FROM core_outbox WHERE kind NOT IN ('notify', 'device.revoked');

UPDATE core_meta SET value = MAX(CAST(value AS INTEGER), 438) WHERE key = 'schema_version';
