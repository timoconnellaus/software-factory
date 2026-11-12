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
  /** The org's current config version (spec 52, migration 0280); null before its first save. */
  config_version: number | null;
}

/** An org's config versions: its workflows and agents (spec 52, migration 0280). */
export interface CoreOrgConfigsTable {
  org_id: string;
  version: number;
  raw: string;
  source: string;
  created_by: string | null;
  note: string | null;
  parent_version: number | null;
  created_at: Iso;
  /** How this version changed the one before it, recorded when it was written. */
  impact: "loosens" | "tightens" | "neutral" | null;
}

/** Spec 52 PR (c): an ended item's shadow verdict (migration 0281), one row per item. */
export interface CoreReconcileItemsTable {
  work_item_id: string;
  org_id: string;
  ended: "done" | "failed" | "rejected" | "cancelled";
  transitions: number;
  /** Disagreeing transitions plus every aspect not yet compared. */
  divergences: number;
  /** The `ShadowVerdict` as JSON. */
  report: JsonText;
  finished_at: Iso;
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
  policy_sha: string | null;
  next_number: Generated<number>;
  created_at: Iso;
  created_by: string;
  /**
   * @deprecated Since 0260 (ADR 0490) the repo lives in core_repositories. Only project.create
   * writes these, as a mirror for code deployed before 0260; nothing reads them. A later migration
   * drops them.
   */
  repo_owner: string;
  /** @deprecated See `repo_owner`. Unique with it: a project with no repository writes its id. */
  repo_name: string;
}

/**
 * 0260 (ADR 0490): a GitHub repository of a project. A project has zero or more; a work item uses
 * one. The repo columns moved here from core_projects.
 */
export interface CoreRepositoriesTable {
  id: string;
  org_id: string;
  project_id: string;
  owner: string;
  name: string;
  default_branch: Generated<string>;
  github_installation_id: string | null;
  /** The org's installation record this repo is reached through (ADR 0055). */
  installation_record_id: string | null;
  /** GitHub's repo id (survives renames). */
  github_repo_id: number | null;
  /** The open PR adding a template `.factory/policy.json`, if one was opened from Setup. */
  policy_pr_url: string | null;
  created_at: Iso;
  created_by: string;
}

/** 0070 (ADR 0280): the last verdict on a project's default-branch protection. */
export interface CoreProjectProtectionTable {
  project_id: string;
  state: "ok" | "red" | "unknown";
  /** JSON string[]: what's missing. */
  problems: JsonText;
  /** JSON string[]: what couldn't be confirmed (not a failure). */
  warnings: JsonText;
  trigger: string;
  checked_at: Iso;
  changed_at: Iso;
  last_ok_at: Iso | null;
}

export interface CoreProjectPoliciesTable {
  project_id: string;
  sha: string;
  ref: string;
  raw: JsonText;
  valid: Bool;
  error: string | null;
  received_at: Iso;
  /** The config version (ADR 0370); null on rows read from git before migration 0140. */
  version: number | null;
  /** app | import | migrated | improver | rollback */
  source: string | null;
  created_by: string | null;
  note: string | null;
  parent_version: number | null;
}

export interface CoreConfigTrialsTable {
  id: string;
  project_id: string;
  base_sha: string;
  candidate_sha: string;
  kind: string;
  summary: string;
  evidence: Generated<JsonText>;
  target_items: number;
  status: Generated<"running" | "promoted" | "disabled">;
  outcome: JsonText | null;
  reason: string | null;
  created_by: string;
  created_at: Iso;
  decided_at: Iso | null;
}

export interface CoreAdjudicationsTable {
  id: string;
  pending_action_id: string;
  project_id: string;
  work_item_id: string;
  kind: "spec" | "step";
  mode: "shadow" | "active";
  job_id: string;
  verdict: "approve" | "defer" | null;
  reason: string | null;
  acted: Generated<Bool>;
  created_at: Iso;
  decided_at: Iso | null;
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
  // 0261 (ADR 0491): before the pipeline; `shaping` is spec 50 part C's.
  | "backlog"
  | "shaping"
  | "ready"
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "done"
  | "failed"
  | "rejected"
  | "cancelled";
export type Size = "small" | "medium" | "large";
/** `attached`: a PR opened outside the factory, verified and merged by it (spec 05). */
export type WorkItemKind = "change" | "incident" | "attached";

export interface CoreWorkItemsTable {
  id: string;
  org_id: string;
  project_id: string;
  number: number;
  slug: string;
  title: string;
  body: Generated<string>;
  kind: Generated<WorkItemKind>;
  requester_user_id: string;
  source: string;
  stage: Generated<Stage>;
  status: Generated<WorkItemStatus>;
  status_reason: string | null;
  size: Size | null;
  spec_required: Bool | null;
  spec_decision_reason: string | null;
  /** 0141 (ADR 0371): the workflow triage picked; null is the skeleton alone. */
  workflow: string | null;
  workflow_reason: string | null;
  /** 0142 (ADR 0373): the trial it ran under, on the trial's candidate version. */
  trial_id: string | null;
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
  /** 0260 (ADR 0490): the repository it uses; null when none is chosen yet. */
  repository_id: string | null;
  /** 0261 (ADR 0491): 0 urgent, 1 high, 2 normal, 3 low. */
  priority: Generated<number>;
  /** 0261: the order within a priority, lower first. */
  rank: Generated<number>;
  /** 0261: JSON string[] written while shaping; null when none. */
  acceptance_criteria: JsonText | null;
  released_at: Iso | null;
  released_by: string | null;
  footprint: Generated<string>;
  /** 0261: when the pipeline started (the pull). */
  pulled_at: Iso | null;
  /** 0262 (ADR 0493): when its Workflow started to run the shaping stages, before release. */
  shaping_started_at: Iso | null;
  /** 0262: when the shaping stages finished, and the default branch's head then. */
  shaped_at: Iso | null;
  shaped_base_sha: string | null;
}

/** 0261 (ADR 0491): `work_item_id` waits for `waits_for_id` to be done. */
export interface CoreWorkItemLinksTable {
  work_item_id: string;
  waits_for_id: string;
  created_at: Iso;
  created_by: string;
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
  /** ADR 0470: accepted under a person's "finish alone" instruction (answered_by is that person). */
  accepted_alone: Generated<Bool>;
  answered_by: string | null;
  answered_at: Iso | null;
  planning_round: number;
  timeout_at: Iso | null;
  escalated_at: Iso | null;
  asked_by: string;
  created_at: Iso;
  // 0120 (spec 20): the kim question model.
  kind: Generated<QuestionKind>;
  /** JSON array of default values (several only for multiple-choice), or null. */
  default_values: JsonText | null;
  /** The [Qn] of provenance tags, per work item. */
  number: number | null;
  position: Generated<number>;
  revision: Generated<number>;
  answer_revision: Generated<number>;
  note: string | null;
  /** Spec 26: the person skipped it; the planning agent decides. */
  skipped: Generated<Bool>;
  /** Spec 26: when this answer revision reached the planning agent. */
  answer_delivered_at: Iso | null;
  /** Spec 27: the person's plan edit this answer was recorded from. */
  answered_via_edit: string | null;
  /** Spec 21: the artifact this question is about, and its options as cards or bound values. */
  artifact_id: string | null;
  option_artifacts: string | null;
  option_values: string | null;
  control: string | null;
  unit: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  planning_session_id: string | null;
  updated_at: Iso | null;
}

export type QuestionKind = "text" | "single-choice" | "multiple-choice" | "yes-no" | "number";

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
  // 0120 (ADR 0302): the living spec's new sections, as JSON, and what a revision changed.
  coverage: Generated<JsonText>;
  clarifications: Generated<JsonText>;
  summary: string | null;
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
  /** `withdrawn`: an attached PR's head moved while its merge gate was open (spec 05). */
  decision: GateDecisionKind | "withdrawn" | null;
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

export type IncidentKind =
  | "sent_back"
  | "run_failed"
  | "run_stalled"
  | "manual"
  /** 0364: a run's archived log is lost; for a person, no agent fix. */
  | "archive_missing";

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
  /** 0120 (ADR 0301): the light pool; null when the runner reports none. */
  light_max: number | null;
  light_in_use: Generated<number>;
  /** 0130 (ADR 0360): the commit the runner's code is at, as it last reported. */
  version: string | null;
  auto_update: Bool | null;
  /** current | waiting | blocked | updating | rolled_back */
  update_state: string | null;
  update_target: string | null;
  update_reason: string | null;
  /** 0180 (ADR 0410): the runner's Claude accounts as it last reported them (names only). */
  accounts: JsonText | null;
  /** The account the owner asked for, until the runner reports it active. */
  account_requested: string | null;
  account_requested_at: Iso | null;
  /** 0320 (ADR 0552): why it takes nothing new in some pools (capacity.paused), or null. */
  paused: JsonText | null;
  /** 0290 (ADR 0520): the runner's RUNNER_COMPAT as it last reported; null (never) counts as 1. */
  compat: number | null;
  /** The signed time (unix seconds) of the last accepted heartbeat: older ones are replays (0360). */
  last_signed_at: number | null;
}

export interface CoreRunnerSharesTable {
  runner_id: string;
  scope: "org" | "factory" | "project";
  scope_id: string;
  created_at: Iso;
}

export type JobStage = "triage" | "spec" | "planning" | "build" | "verify";
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
  /** 0120 (ADR 0301). */
  pool: Generated<"heavy" | "light">;
  /** Queued for an item still shaping (ADR 0493): the claim takes it after released work (0363). */
  shaping: Generated<number>;
  pinned_runner_id: string | null;
  planning_session_id: string | null;
  /** 0141 (ADR 0372): standard | light; null is standard. */
  tier: string | null;
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
  /** When the run's events and steers were archived to R2 (migration 0362). */
  events_archived_at: Iso | null;
  /** How its session ran (ADR 0450), from its `session.started` (migration 0362). */
  session_mode: "terminal" | "stream" | null;
}

/** The archiver's lease on a run (migration 0362): one tick archives a run at a time. */
export interface CoreRunArchiveLeasesTable {
  run_id: string;
  holder: string;
  expires_at: Iso;
}

/** One archived chunk of a run's events in sf-archive (migration 0362); steers are first_seq -1. */
export interface CoreRunArchiveChunksTable {
  run_id: string;
  first_seq: number;
  last_seq: number;
  r2_key: string;
  rows: number;
  bytes: number;
  sha256: string;
  archived_at: Iso;
}

export interface CoreRunEventsTable {
  run_id: string;
  seq: number;
  at: Iso;
  type: string;
  payload: JsonText;
  /** Set on a row that holds a batch of log lines, `seq` to `last_seq` (migration 0361). */
  last_seq: number | null;
}

/** A person's message into a live run (spec 31, ADR 0400). */
export interface CoreRunSteersTable {
  id: string;
  run_id: string;
  work_item_id: string;
  author_user_id: string;
  text: string;
  created_at: Iso;
  delivered_at: Iso | null;
  /** ADR 0470: stop the agent's current step before submitting the text. */
  interrupt: Generated<Bool>;
  /** `message` (a steer) or `takeover` (stop the stream session for a person, ADR 0450). */
  kind: Generated<"message" | "takeover">;
}

/** A person opening a run's web terminal (spec 35, ADR 0440). */
export interface CoreRunTerminalAttachesTable {
  id: string;
  run_id: string;
  work_item_id: string;
  user_id: string;
  mode: "type" | "watch";
  opened_at: Iso;
  closed_at: Iso | null;
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
  /** 0260 (ADR 0490): the repository the head SHA is in. */
  repository_id: string | null;
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

// ---- 0090: work item attachments (ADR 0310) ----

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
// ---- 0100: the merge queue (ADR 0330) ----

export type MergeQueueStatus = "queued" | "merged" | "left";

export interface CoreMergeQueueTable {
  id: string;
  project_id: string;
  work_item_id: string;
  workflow_id: string | null;
  pending_action_id: string | null;
  approved_sha: string;
  head_sha: string;
  status: Generated<MergeQueueStatus>;
  end_reason: string | null;
  enqueued_at: Iso;
  updated_at: Iso;
  ended_at: Iso | null;
}

// ---- 0120: planning, the loop (spec 20, ADR 0300, 0350) ----

export type PlanningSessionStatus =
  | "starting"
  | "working"
  | "idle"
  | "yielding"
  | "yielded"
  | "interrupted"
  | "ended"
  | "moved";

export interface CorePlanningSessionsTable {
  id: string;
  work_item_id: string;
  runner_id: string | null;
  session_ref: string;
  status: Generated<PlanningSessionStatus>;
  current_job_id: string | null;
  delivered_cursor: Generated<number>;
  round: Generated<number>;
  ready_spec_id: string | null;
  ready_at: Iso | null;
  at_gate: Generated<Bool>;
  idle_since: Iso | null;
  agent_seen_at: Iso | null;
  yield_requested_at: Iso | null;
  activity: string | null;
  focused_question_id: string | null;
  announced_at: Iso | null;
  /** ADR 0470: a person paused the planner; news doesn't wake it until resumed. */
  paused_at: Iso | null;
  paused_by: string | null;
  /** ADR 0470: who told the planner to finish alone, and when; null while it's off. */
  finish_alone_by: string | null;
  finish_alone_at: Iso | null;
  /** Spec 21: the artifact the planner put on screen last. */
  shown_artifact_id: string | null;
  /** Spec 26: the highest cursor handed to the harness; a hook's ack is clamped to it. */
  handed_cursor: Generated<number>;
  /** Spec 26: JSON `{ questionId: answer revision }` handed out, for read receipts. */
  handed_answers: string | null;
  /** Spec 26: the last "away" notice, so questions and replies notify once per burst. */
  notified_at: Iso | null;
  replaces_session_id: string | null;
  created_by: string;
  created_at: Iso;
  updated_at: Iso;
  ended_at: Iso | null;
  end_reason: string | null;
}

export interface CorePlanningEventsTable {
  id: Generated<number>;
  work_item_id: string;
  type: string;
  actor_type: string;
  actor_id: string;
  payload: Generated<JsonText>;
  at: Iso;
}

export interface CorePlanningMessagesTable {
  id: string;
  work_item_id: string;
  author_kind: "person" | "agent";
  author_id: string;
  text: string;
  question_id: string | null;
  reply_to: string | null;
  kind: Generated<"chat" | "gate">;
  delivered_at: Iso | null;
  created_at: Iso;
  /** Spec 26: the steer this message was typed as; delivered when the host takes it. */
  steer_id: string | null;
  /** Spec 27: a comment's anchor on plan lines, as JSON `{ specId, lineStart, lineEnd, quote }`. */
  anchor: string | null;
  /** Spec 21: a comment pinned to a spot in an artifact, as JSON. */
  pin: string | null;
}

/** A planning artifact (spec 21, ADR 0472): a mockup, diagram or document. */
export interface CorePlanningArtifactsTable {
  id: string;
  work_item_id: string;
  kind: "mockup" | "diagram" | "document";
  title: string;
  description: string | null;
  revision: Generated<number>;
  keep: Generated<Bool>;
  created_by: string;
  created_at: Iso;
  updated_at: Iso;
  deleted_at: Iso | null;
}

/** One revision of a planning artifact's content (spec 21). */
export interface CorePlanningArtifactRevisionsTable {
  artifact_id: string;
  revision: number;
  content: string;
  size: number;
  controls: Generated<string>;
  created_at: Iso;
}

/** A person's edit to the plan's source lines (spec 27, ADR 0471). */
export interface CoreSpecEditsTable {
  id: string;
  work_item_id: string;
  spec_id: string;
  base_spec_id: string;
  line_start: number;
  line_end: number;
  before: string;
  after: string;
  author_id: string;
  created_at: Iso;
  replaced_by: string | null;
  released_at: Iso | null;
  released_by: string | null;
  footprint: Generated<string>;
}

export interface CorePlanningPresenceTable {
  work_item_id: string;
  user_id: string;
  seen_at: Iso;
  left_at: Iso | null;
}

// ---- 0110: the sf CLI (ADR 0340) ----

export type CliScope = "read" | "write";

export interface CoreCliDeviceCodesTable {
  id: string;
  device_code_hash: string;
  user_code: string;
  client_name: string | null;
  requested_scope: Generated<CliScope>;
  granted_scope: CliScope | null;
  status: Generated<"pending" | "approved" | "denied" | "consumed">;
  decided_by: string | null;
  token_id: string | null;
  created_at: Iso;
  expires_at: Iso;
  decided_at: Iso | null;
  consumed_at: Iso | null;
}

export interface CoreCliTokensTable {
  id: string;
  token_hash: string;
  user_id: string;
  name: string | null;
  scope: CliScope;
  created_at: Iso;
  expires_at: Iso;
  revoked_at: Iso | null;
  /**
   * `cli` (sf), `desktop` (the desktop app) or `mobile` (the phone app), the last two bound to
   * `device_id` (ADR 0391, 0541).
   */
  kind: Generated<"cli" | "desktop" | "mobile">;
  device_id: string | null;
}

/** Where a device's key lives (ADR 0391, 0541): only the first three may decide. */
export type KeyStorage = "secure-enclave" | "strongbox" | "tee" | "software";
export type DevicePlatform = "macos" | "android";

export interface CoreDesktopAuthRequestsTable {
  id: string;
  code_challenge: string;
  device_name: string;
  /** The device's P-256 public key, as JWK JSON. */
  public_key: string;
  key_storage: Generated<KeyStorage>;
  platform: Generated<DevicePlatform>;
  /** A phone's parsed key attestation (ADR 0541), JSON. */
  attestation: string | null;
  /** The pair offer that approved a phone's sign-in (QR or typed code). */
  offer_id: string | null;
  state: string;
  status: Generated<"pending" | "approved" | "denied" | "consumed">;
  user_id: string | null;
  code_hash: string | null;
  device_id: string | null;
  created_at: Iso;
  expires_at: Iso;
  decided_at: Iso | null;
  consumed_at: Iso | null;
}

export interface CoreDesktopDevicesTable {
  id: string;
  user_id: string;
  name: string;
  public_key: string;
  key_storage: KeyStorage;
  platform: Generated<DevicePlatform>;
  /** A phone's parsed key attestation (ADR 0541), JSON; null for a Mac. */
  attestation: string | null;
  /** 1: the device may decide with a presence proof; 0: one-tap only (ADR 0541 decision 6). */
  decides: Generated<number>;
  created_at: Iso;
  last_seen_at: Iso | null;
  revoked_at: Iso | null;
}

export interface CoreMobileNoncesTable {
  nonce_hash: string;
  /** A hash of the caller's network address, as the door saw it (per-caller limits). */
  caller: Generated<string>;
  created_at: Iso;
  expires_at: Iso;
  consumed_at: Iso | null;
}

export interface CorePairOffersTable {
  id: string;
  user_id: string;
  surface: "app" | "desktop";
  secret_hash: string;
  code_tag: string;
  code_hash: string;
  attempts: Generated<number>;
  created_at: Iso;
  expires_at: Iso;
  consumed_at: Iso | null;
  closed_at: Iso | null;
  device_id: string | null;
}

export interface CorePairCodeTriesTable {
  id: string;
  at: Iso;
  ok: number;
  /** A hash of the caller's network address, as the door saw it (per-caller limits). */
  caller: Generated<string>;
}

export interface CorePresenceChallengesTable {
  id: string;
  device_id: string;
  op: string;
  input_digest: string;
  summary: string;
  nonce_hash: string;
  created_at: Iso;
  expires_at: Iso;
  consumed_at: Iso | null;
}

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
  core_repositories: CoreRepositoriesTable;
  core_project_policies: CoreProjectPoliciesTable;
  core_org_configs: CoreOrgConfigsTable;
  core_reconcile_items: CoreReconcileItemsTable;
  core_config_trials: CoreConfigTrialsTable;
  core_adjudications: CoreAdjudicationsTable;
  core_project_protection: CoreProjectProtectionTable;
  core_kill_switches: CoreKillSwitchesTable;
  core_batch_guard: CoreBatchGuardTable;
  core_work_items: CoreWorkItemsTable;
  core_work_item_links: CoreWorkItemLinksTable;
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
  core_run_archive_chunks: CoreRunArchiveChunksTable;
  core_run_archive_leases: CoreRunArchiveLeasesTable;
  core_run_steers: CoreRunSteersTable;
  core_run_terminal_attaches: CoreRunTerminalAttachesTable;
  core_artifacts: CoreArtifactsTable;
  core_leases: CoreLeasesTable;
  core_channel_requests: CoreChannelRequestsTable;
  core_connector_events: CoreConnectorEventsTable;
  core_verify_checks: CoreVerifyChecksTable;
  core_github_installations: CoreGithubInstallationsTable;
  core_github_connect_states: CoreGithubConnectStatesTable;
  core_runner_device_codes: CoreRunnerDeviceCodesTable;
  core_attachments: CoreAttachmentsTable;
  core_merge_queue: CoreMergeQueueTable;
  core_planning_sessions: CorePlanningSessionsTable;
  core_planning_events: CorePlanningEventsTable;
  core_planning_messages: CorePlanningMessagesTable;
  core_planning_presence: CorePlanningPresenceTable;
  core_spec_edits: CoreSpecEditsTable;
  core_planning_artifacts: CorePlanningArtifactsTable;
  core_planning_artifact_revisions: CorePlanningArtifactRevisionsTable;
  core_cli_device_codes: CoreCliDeviceCodesTable;
  core_cli_tokens: CoreCliTokensTable;
  core_desktop_auth_requests: CoreDesktopAuthRequestsTable;
  core_desktop_devices: CoreDesktopDevicesTable;
  core_presence_challenges: CorePresenceChallengesTable;
  core_mobile_nonces: CoreMobileNoncesTable;
  core_pair_offers: CorePairOffersTable;
  core_pair_code_tries: CorePairCodeTriesTable;
}
