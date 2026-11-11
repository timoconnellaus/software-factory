// Kysely table types for the core_* schema (ADR 0050). Hand-maintained next to the SQL migrations in
// ../migrations, updated in the same commit as each migration. JSON columns are TEXT holding JSON;
// use `json()`/`parseJson()` from ./json.ts to cross the boundary.
import type { Generated } from "kysely";

/** ISO-8601 UTC timestamp string. */
export type Iso = string;
/** A TEXT column holding JSON. */
export type JsonText = string;
/** SQLite boolean: 0 or 1. */
export type Bool = number;

// ---- 0010: identity, orgs, factories, projects, policy, kill switches ----

export interface CoreMetaTable {
  key: string;
  value: string;
}

export interface CoreUserTable {
  id: string;
  name: string;
  email: string;
  email_verified: Generated<Bool>;
  image: string | null;
  github_login: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface CoreSessionTable {
  id: string;
  user_id: string;
  token: string;
  expires_at: Iso;
  ip_address: string | null;
  user_agent: string | null;
  active_organization_id: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface CoreAccountTable {
  id: string;
  user_id: string;
  account_id: string;
  provider_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: Iso | null;
  refresh_token_expires_at: Iso | null;
  scope: string | null;
  password: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface CoreVerificationTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: Iso;
  created_at: Iso;
  updated_at: Iso;
}

export type OrgKind = "personal" | "team" | "client";

export interface CoreOrganizationTable {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  metadata: string | null;
  kind: Generated<OrgKind>;
  github_installation_id: string | null;
  created_at: Iso;
}

export interface CoreMemberTable {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  created_at: Iso;
}

export interface CoreInvitationTable {
  id: string;
  organization_id: string;
  email: string;
  role: string | null;
  status: string;
  expires_at: Iso;
  inviter_id: string;
  created_at: Iso;
}

export interface CoreFactoriesTable {
  id: string;
  org_id: string;
  name: string;
  created_at: Iso;
  created_by: string;
}

export interface CoreProjectsTable {
  id: string;
  org_id: string;
  factory_id: string;
  name: string;
  slug: string;
  repo_owner: string;
  repo_name: string;
  default_branch: Generated<string>;
  github_installation_id: string | null;
  policy_sha: string | null;
  next_number: Generated<number>;
  created_at: Iso;
  created_by: string;
  /** 0060: the org's installation record this project's repo is reached through. */
  installation_record_id: string | null;
  /** 0060: GitHub's repo id (survives renames). */
  github_repo_id: number | null;
  /** 0060: the open PR adding a template `.factory/policy.json`, if one was opened from Setup. */
  policy_pr_url: string | null;
}

export interface CoreProjectPoliciesTable {
  project_id: string;
  sha: string;
  ref: string;
  raw: JsonText;
  valid: Bool;
  error: string | null;
  received_at: Iso;
}

export type KillScope = "org" | "project";

export interface CoreKillSwitchesTable {
  scope: KillScope;
  scope_id: string;
  is_on: Generated<Bool>;
  epoch: Generated<number>;
  reason: string | null;
  changed_at: Iso;
  changed_by: string;
}

export interface CoreBatchGuardTable {
  name: string;
  ok: number;
}

// ---- 0020: work ----

export type Stage = "intake" | "triage" | "spec" | "build" | "verify" | "merge" | "done";
export type WorkItemStatus =
  | "running"
  | "waiting"
  | "paused"
  | "done"
  | "failed"
  | "rejected"
  | "cancelled";
export type Size = "small" | "medium" | "large";

export interface CoreWorkItemsTable {
  id: string;
  org_id: string;
  project_id: string;
  number: number;
  slug: string;
  title: string;
  body: Generated<string>;
  kind: Generated<"change" | "incident">;
  requester_user_id: string;
  source: string;
  stage: Generated<Stage>;
  status: Generated<WorkItemStatus>;
  status_reason: string | null;
  size: Size | null;
  spec_required: Bool | null;
  spec_decision_reason: string | null;
  domains: Generated<JsonText>;
  current_spec_id: string | null;
  branch: string;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  planning_round: Generated<number>;
  build_attempts: Generated<number>;
  workflow_id: string;
  workflow_version: number | null;
  policy_sha: string | null;
  parent_work_item_id: string | null;
  created_at: Iso;
  updated_at: Iso;
  closed_at: Iso | null;
}

export interface CoreIntakeKeysTable {
  dedupe_key: string;
  work_item_id: string;
  created_at: Iso;
}

export interface CoreIntakeEventsTable {
  event_id: string;
  dedupe_key: string;
  work_item_id: string;
  outcome: "created" | "attached";
  source: string;
  title: string;
  body: Generated<string>;
  actor_id: string;
  received_at: Iso;
}

export type StageStatus = "active" | "done" | "skipped" | "sent_back" | "failed" | "cancelled";

export interface CoreStagesTable {
  id: string;
  work_item_id: string;
  stage: Stage;
  attempt: number;
  status: Generated<StageStatus>;
  reason: string | null;
  started_at: Iso;
  ended_at: Iso | null;
}

export type QuestionVisibility = "owners" | "assignee" | "org";

export interface CoreQuestionsTable {
  id: string;
  work_item_id: string;
  project_id: string;
  org_id: string;
  domain: Generated<string>;
  prompt: string;
  context: string | null;
  options: Generated<JsonText>;
  default_answer: string | null;
  recommendation: string | null;
  recommendation_reason: string | null;
  blocking: Generated<Bool>;
  irreversible: Generated<Bool>;
  visibility: Generated<QuestionVisibility>;
  assignee_user_id: string | null;
  status: Generated<"open" | "answered" | "withdrawn">;
  answer: string | null;
  accepted_default: Generated<Bool>;
  answered_by: string | null;
  answered_at: Iso | null;
  planning_round: number;
  timeout_at: Iso | null;
  escalated_at: Iso | null;
  asked_by: string;
  created_at: Iso;
}

export interface CoreSpecsTable {
  id: string;
  work_item_id: string;
  version: number;
  body_md: string;
  acceptance_criteria: Generated<JsonText>;
  assumptions: Generated<JsonText>;
  status: Generated<"draft" | "approved" | "superseded">;
  path: string | null;
  commit_sha: string | null;
  created_by: string;
  created_at: Iso;
  approved_at: Iso | null;
  approved_by: string | null;
}

export type PendingActionKind = "spec" | "merge" | "approval";
export type PendingActionStatus = "pending" | "approved" | "rejected" | "applied";
export type GateDecisionKind = "approved" | "rejected" | "changes_requested" | "sent_back";

export interface CorePendingActionsTable {
  id: string;
  org_id: string | null;
  project_id: string | null;
  work_item_id: string | null;
  workflow_id: string | null;
  kind: PendingActionKind;
  operation: string;
  risk: string;
  actor_type: string;
  actor_id: string;
  input: JsonText;
  reason: string | null;
  status: Generated<PendingActionStatus>;
  decision: GateDecisionKind | null;
  assignee_user_id: string | null;
  escalations: Generated<number>;
  timeout_at: Iso | null;
  policy_sha: string | null;
  created_at: Iso;
  decided_at: Iso | null;
  decided_by: string | null;
  note: string | null;
  opened_full_diff: Bool | null;
  gate_open_ms: number | null;
}

export interface CoreReviewPacketsTable {
  id: string;
  work_item_id: string;
  run_id: string | null;
  head_sha: string;
  verdict: "pass" | "fail";
  summary: Generated<string>;
  criteria: Generated<JsonText>;
  checks: Generated<JsonText>;
  reviewer: JsonText | null;
  risk_flags: Generated<JsonText>;
  sections: Generated<JsonText>;
  created_at: Iso;
}

export type IncidentKind = "sent_back" | "run_failed" | "run_stalled" | "manual";

export interface CoreIncidentsTable {
  id: string;
  org_id: string;
  project_id: string;
  source_work_item_id: string;
  run_id: string | null;
  kind: IncidentKind;
  reason: string;
  fix_work_item_id: string | null;
  created_by: string;
  created_at: Iso;
  /** 0040: the root-cause class (`packages/core` incidents/classify). */
  root_cause: string | null;
  /** 0040: the proposed `.factory/` fix, markdown. */
  proposed_fix: string | null;
}

export type AuditDecision = "allow" | "review" | "deny" | "n/a";
export type AuditOutcome =
  | "ok"
  | "review"
  | "denied"
  | "forbidden"
  | "killed"
  | "fenced"
  | "failed";

export interface CoreAuditTable {
  id: string;
  at: Iso;
  operation: string;
  risk: string;
  actor_type: string;
  actor_id: string;
  origin: JsonText;
  decision: AuditDecision;
  outcome: AuditOutcome;
  reason: string | null;
  org_id: string | null;
  project_id: string | null;
  work_item_id: string | null;
  policy_sha: string | null;
  input: JsonText;
  result: JsonText | null;
  diff: Generated<JsonText>;
  pending_action_id: string | null;
  approval_id: string | null;
  idempotency_key: string | null;
}

export interface CoreOutboxTable {
  id: string;
  at: Iso;
  kind: string;
  payload: JsonText;
  attempts: Generated<number>;
  next_at: Iso;
  last_error: string | null;
}

// ---- 0030: runners, jobs, runs, leases ----

export interface CoreRunnersTable {
  id: string;
  owner_user_id: string;
  name: string;
  key_version: Generated<number>;
  manifest: JsonText | null;
  capacity_max: Generated<number>;
  capacity_in_use: Generated<number>;
  accepting: Generated<Bool>;
  rate_limited_until: Iso | null;
  last_seen_at: Iso | null;
  revoked_at: Iso | null;
  created_at: Iso;
}

export interface CoreRunnerSharesTable {
  runner_id: string;
  scope: "org" | "factory" | "project";
  scope_id: string;
  created_at: Iso;
}

export type JobStage = "triage" | "spec" | "build" | "verify";
export type JobStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

export interface CoreJobsTable {
  id: string;
  work_item_id: string;
  project_id: string;
  org_id: string;
  stage: JobStage;
  role: string;
  harness: Generated<string>;
  requires: Generated<JsonText>;
  prompt: string;
  context: Generated<JsonText>;
  session_timeout_ms: number;
  status: Generated<JobStatus>;
  wait_reason: string | null;
  runner_id: string | null;
  claim_id: string | null;
  run_id: string | null;
  created_at: Iso;
  claimed_at: Iso | null;
  finished_at: Iso | null;
}

export type RunStatus =
  | "claimed"
  | "preparing"
  | "running"
  | "collecting"
  | "handed_back"
  | "failed"
  | "cancelled";

export interface CoreRunsTable {
  id: string;
  job_id: string;
  work_item_id: string;
  run_no: number;
  stage: JobStage;
  runner_id: string;
  branch: string;
  base_branch: string;
  fencing_token: number;
  status: Generated<RunStatus>;
  outcome: string | null;
  summary: string | null;
  head_sha: string | null;
  result: JsonText | null;
  takeover: JsonText | null;
  started_at: Iso;
  last_event_at: Iso | null;
  ended_at: Iso | null;
  released_at: Iso | null;
}

export interface CoreRunEventsTable {
  run_id: string;
  seq: number;
  at: Iso;
  type: string;
  payload: JsonText;
}

export interface CoreArtifactsTable {
  id: string;
  run_id: string;
  kind: string;
  name: string | null;
  meta: Generated<JsonText>;
  body: string | null;
  r2_key: string | null;
  created_at: Iso;
}

export interface CoreLeasesTable {
  work_item_id: string;
  holder_kind: "run" | "session" | null;
  holder_id: string | null;
  fencing_token: Generated<number>;
  claimed_at: Iso | null;
  expires_at: Iso | null;
  released_at: Iso | null;
}

export interface CoreChannelRequestsTable {
  runner_id: string;
  idempotency_key: string;
  body_hash: string;
  status: "pending" | "done";
  response_status: number | null;
  response: string | null;
  at: Iso;
}

// ---- 0040: the GitHub connector and `factory/verify` ----

export interface CoreConnectorEventsTable {
  provider: string;
  delivery_id: string;
  event: string;
  action: string | null;
  repo: string | null;
  received_at: Iso;
}

export type VerifyCheckStatus = "queued" | "in_progress" | "completed";
export type VerifyCheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "action_required";

export interface CoreVerifyChecksTable {
  project_id: string;
  head_sha: string;
  work_item_id: string | null;
  pr_number: number | null;
  github_check_run_id: string | null;
  status: VerifyCheckStatus;
  conclusion: VerifyCheckConclusion | null;
  title: string;
  review_packet_id: string | null;
  updated_at: Iso;
}

// ---- 0060: onboarding (installations, connect state, runner device login) ----

export type InstallationAccountType = "User" | "Organization";
export type InstallationStatus = "active" | "suspended" | "deleted";

export interface CoreGithubInstallationsTable {
  id: string;
  org_id: string;
  installation_id: string;
  account_login: string;
  account_type: InstallationAccountType;
  repository_selection: "all" | "selected";
  status: InstallationStatus;
  connected_by: string;
  created_at: Iso;
  updated_at: Iso;
}

export interface CoreGithubConnectStatesTable {
  state_hash: string;
  org_id: string;
  user_id: string;
  created_at: Iso;
  expires_at: Iso;
  used_at: Iso | null;
}

export type DeviceCodeStatus = "pending" | "approved" | "denied" | "consumed";

export interface CoreRunnerDeviceCodesTable {
  id: string;
  device_code_hash: string;
  user_code: string;
  suggested_name: string | null;
  status: DeviceCodeStatus;
  decided_by: string | null;
  runner_id: string | null;
  created_at: Iso;
  expires_at: Iso;
  decided_at: Iso | null;
  consumed_at: Iso | null;
}

// ---- 0070: work item attachments (ADR 0260) ----

export interface CoreAttachmentsTable {
  id: string;
  work_item_id: string;
  org_id: string;
  project_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  /** `<org>/<work item>/<attachment id>` in the ATTACHMENTS bucket. */
  blob_key: string;
  uploader_type: string;
  uploader_id: string;
  created_at: Iso;
}

/** Every core table, for `Kysely<CoreDatabase>`. */
export interface CoreDatabase {
  core_meta: CoreMetaTable;
  core_user: CoreUserTable;
  core_session: CoreSessionTable;
  core_account: CoreAccountTable;
  core_verification: CoreVerificationTable;
  core_organization: CoreOrganizationTable;
  core_member: CoreMemberTable;
  core_invitation: CoreInvitationTable;
  core_factories: CoreFactoriesTable;
  core_projects: CoreProjectsTable;
  core_project_policies: CoreProjectPoliciesTable;
  core_kill_switches: CoreKillSwitchesTable;
  core_batch_guard: CoreBatchGuardTable;
  core_work_items: CoreWorkItemsTable;
  core_intake_keys: CoreIntakeKeysTable;
  core_intake_events: CoreIntakeEventsTable;
  core_stages: CoreStagesTable;
  core_questions: CoreQuestionsTable;
  core_specs: CoreSpecsTable;
  core_pending_actions: CorePendingActionsTable;
  core_review_packets: CoreReviewPacketsTable;
  core_incidents: CoreIncidentsTable;
  core_audit: CoreAuditTable;
  core_outbox: CoreOutboxTable;
  core_runners: CoreRunnersTable;
  core_runner_shares: CoreRunnerSharesTable;
  core_jobs: CoreJobsTable;
  core_runs: CoreRunsTable;
  core_run_events: CoreRunEventsTable;
  core_artifacts: CoreArtifactsTable;
  core_leases: CoreLeasesTable;
  core_channel_requests: CoreChannelRequestsTable;
  core_connector_events: CoreConnectorEventsTable;
  core_verify_checks: CoreVerifyChecksTable;
  core_github_installations: CoreGithubInstallationsTable;
  core_github_connect_states: CoreGithubConnectStatesTable;
  core_runner_device_codes: CoreRunnerDeviceCodesTable;
  core_attachments: CoreAttachmentsTable;
}
