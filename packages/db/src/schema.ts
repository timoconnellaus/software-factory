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

// ---- 0010: identity and orgs (the old pipeline's tables went in 0438) ----

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

export interface CoreBatchGuardTable {
  name: string;
  ok: number;
}

// ---- 0020: the audit journal and the outbox ----

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

// ---- 0030: runners and the channel's idempotency store ----

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

export interface CoreChannelRequestsTable {
  runner_id: string;
  idempotency_key: string;
  body_hash: string;
  status: "pending" | "done";
  response_status: number | null;
  response: string | null;
  at: Iso;
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

/** Every core table, for `Kysely<CoreDatabase>`. */
// ---- 0110, 0160, 0310: the CLI's, the desktop app's and the phone's sign-ins and devices ----

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
// The new core's flow_* tables are read with plain SQL in packages/store.
export interface CoreDatabase {
  core_meta: CoreMetaTable;
  core_user: CoreUserTable;
  core_session: CoreSessionTable;
  core_account: CoreAccountTable;
  core_verification: CoreVerificationTable;
  core_organization: CoreOrganizationTable;
  core_member: CoreMemberTable;
  core_invitation: CoreInvitationTable;
  core_batch_guard: CoreBatchGuardTable;
  core_audit: CoreAuditTable;
  core_outbox: CoreOutboxTable;
  core_runners: CoreRunnersTable;
  core_runner_shares: CoreRunnerSharesTable;
  core_channel_requests: CoreChannelRequestsTable;
  core_github_installations: CoreGithubInstallationsTable;
  core_github_connect_states: CoreGithubConnectStatesTable;
  core_runner_device_codes: CoreRunnerDeviceCodesTable;
  core_cli_device_codes: CoreCliDeviceCodesTable;
  core_cli_tokens: CoreCliTokensTable;
  core_desktop_auth_requests: CoreDesktopAuthRequestsTable;
  core_desktop_devices: CoreDesktopDevicesTable;
  core_presence_challenges: CorePresenceChallengesTable;
  core_mobile_nonces: CoreMobileNoncesTable;
  core_pair_offers: CorePairOffersTable;
  core_pair_code_tries: CorePairCodeTriesTable;
}
