// Resolving what a call is about (work item → project → org), the policy in force, kill switches
// and who the approvers are. Used by `invoke()` and by handlers that need the same answers.
import type { Db, KillScope } from "@software-factory/db";
import type { Actor } from "./actors.ts";
import { OperationError } from "./errors.ts";
import type { ProjectRow, RepositoryRow, Scope, ScopeRef, WorkItemRow } from "./operation.ts";
import { onOrgWorkflow, type ProjectPolicy, parseProjectPolicy } from "./policy/project-policy.ts";
import { EMPTY_ORG_CONFIG, parseOrgConfig } from "./stages/org-config.ts";
import { effectivePolicy, type OverrideApprovals } from "./stages/project-workflow.ts";

const EMPTY: Scope = {
  orgId: null,
  projectId: null,
  workItemId: null,
  workItem: null,
  project: null,
  repositories: [],
  repository: null,
  policy: null,
  rawPolicy: null,
  policySha: null,
  policyError: null,
  pinnedPolicy: null,
};

/** Reads the scope-naming fields from an operation's input. */
export function defaultScopeRef(input: unknown): ScopeRef {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  const pick = (k: string) => (typeof record[k] === "string" ? (record[k] as string) : null);
  return {
    workItemId: pick("workItemId"),
    projectId: pick("projectId"),
    repositoryId: pick("repositoryId"),
    orgId: pick("orgId"),
    jobId: pick("jobId"),
    questionId: pick("questionId"),
    pendingActionId: pick("pendingActionId"),
  };
}

/**
 * The work item, project and org a call is about, and the project's policy. With `d1`, the
 * dependent lookups (work item → project → policy) and the caller's role in the org go to D1 as
 * one batch, using subqueries, so resolving a scope costs one round trip instead of four. `role` is
 * `undefined` when it wasn't asked for (no `userId`) and `null` when they aren't a member.
 */
export async function resolveScope(db: Db, ref: ScopeRef): Promise<Scope>;
export async function resolveScope(
  db: Db,
  ref: ScopeRef,
  batch: { d1: D1Database; userId: string | null; skipOrgWorkflow?: boolean },
): Promise<Scope & { role: string | null | undefined }>;
export async function resolveScope(
  db: Db,
  ref: ScopeRef,
  batch?: { d1: D1Database; userId: string | null; skipOrgWorkflow?: boolean },
): Promise<Scope & { role?: string | null | undefined }> {
  let workItemId = ref.workItemId ?? null;
  if (!workItemId && ref.jobId) {
    workItemId =
      (
        await db
          .selectFrom("core_jobs")
          .select("work_item_id")
          .where("id", "=", ref.jobId)
          .executeTakeFirst()
      )?.work_item_id ?? null;
    if (!workItemId) throw new OperationError("not_found", `no job ${ref.jobId}`);
  }
  if (!workItemId && ref.questionId) {
    workItemId =
      (
        await db
          .selectFrom("core_questions")
          .select("work_item_id")
          .where("id", "=", ref.questionId)
          .executeTakeFirst()
      )?.work_item_id ?? null;
    if (!workItemId) throw new OperationError("not_found", `no question ${ref.questionId}`);
  }
  let projectId = ref.projectId ?? null;
  let orgId = ref.orgId ?? null;
  const repositoryId = ref.repositoryId ?? null;
  if (!workItemId && ref.pendingActionId) {
    const pa = await db
      .selectFrom("core_pending_actions")
      .select(["work_item_id", "project_id", "org_id"])
      .where("id", "=", ref.pendingActionId)
      .executeTakeFirst();
    if (!pa) throw new OperationError("not_found", `no pending action ${ref.pendingActionId}`);
    workItemId = pa.work_item_id;
    projectId ??= pa.project_id;
    orgId ??= pa.org_id;
  }

  if (!workItemId && !projectId && repositoryId) {
    projectId =
      (
        await db
          .selectFrom("core_repositories")
          .select("project_id")
          .where("id", "=", repositoryId)
          .executeTakeFirst()
      )?.project_id ?? null;
    if (!projectId) throw new OperationError("not_found", `no repository ${repositoryId}`);
  }

  if (batch) {
    return resolveBatched(
      db,
      batch.d1,
      { workItemId, projectId, orgId, repositoryId },
      batch.userId,
      batch.skipOrgWorkflow ?? false,
    );
  }

  let workItem: WorkItemRow | null = null;
  if (workItemId) {
    workItem =
      (await db
        .selectFrom("core_work_items")
        .selectAll()
        .where("id", "=", workItemId)
        .executeTakeFirst()) ?? null;
    if (!workItem) throw new OperationError("not_found", `no work item ${workItemId}`);
    projectId = workItem.project_id;
    orgId = workItem.org_id;
  }

  let project: ProjectRow | null = null;
  if (projectId) {
    project =
      (await db
        .selectFrom("core_projects")
        .selectAll()
        .where("id", "=", projectId)
        .executeTakeFirst()) ?? null;
    if (!project) throw new OperationError("not_found", `no project ${projectId}`);
    orgId = project.org_id;
  }

  if (!project) return { ...EMPTY, orgId, workItemId };
  const repositories = await db
    .selectFrom("core_repositories")
    .selectAll()
    .where("project_id", "=", project.id)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const repository = pickRepository(repositories, workItem, repositoryId);
  const raw = await loadPolicy(db, project);
  const pinnedRaw =
    workItem?.policy_sha && workItem.policy_sha !== project.policy_sha
      ? (await loadPolicy(db, { id: project.id, policy_sha: workItem.policy_sha })).policy
      : null;
  const resolved = await withOrgWorkflow(db, project.org_id, raw, pinnedRaw, workItem, project.id);
  return {
    orgId,
    projectId,
    workItemId,
    workItem,
    project,
    repositories,
    repository,
    ...resolved,
    policySha: project.policy_sha,
  };
}

/**
 * The repository a call is about (ADR 0490): the work item's; else the one named; else the project's
 * only one. Refuses a named repository that isn't the project's.
 */
function pickRepository(
  repositories: RepositoryRow[],
  workItem: Pick<WorkItemRow, "repository_id"> | null,
  repositoryId: string | null,
): RepositoryRow | null {
  const id = workItem?.repository_id ?? repositoryId;
  if (id) {
    const found = repositories.find((r) => r.id === id);
    if (!found) throw new OperationError("not_found", `no repository ${id} on this project`);
    return found;
  }
  return repositories.length === 1 ? (repositories[0] ?? null) : null;
}

type PolicyRow = { raw: string; valid: number; error: string | null };

/** `resolveScope`'s lookups as one D1 batch: the same answers and the same refusals. */
async function resolveBatched(
  db: Db,
  d1: D1Database,
  ids: {
    workItemId: string | null;
    projectId: string | null;
    orgId: string | null;
    repositoryId: string | null;
  },
  userId: string | null,
  skipOrgWorkflow: boolean,
): Promise<Scope & { role: string | null | undefined }> {
  // The project is the work item's when there is one (as in the unbatched path).
  const projectExpr = ids.workItemId
    ? { sql: "(SELECT project_id FROM core_work_items WHERE id = ?)", arg: ids.workItemId }
    : ids.projectId
      ? { sql: "?", arg: ids.projectId }
      : null;
  const orgExpr = ids.workItemId
    ? { sql: "(SELECT org_id FROM core_work_items WHERE id = ?)", arg: ids.workItemId }
    : ids.projectId
      ? { sql: "(SELECT org_id FROM core_projects WHERE id = ?)", arg: ids.projectId }
      : ids.orgId
        ? { sql: "?", arg: ids.orgId }
        : null;

  const statements: D1PreparedStatement[] = [];
  const at: {
    workItem?: number;
    project?: number;
    repositories?: number;
    policy?: number;
    pinned?: number;
    role?: number;
  } = {};
  if (ids.workItemId) {
    at.workItem = statements.length;
    statements.push(d1.prepare("SELECT * FROM core_work_items WHERE id = ?").bind(ids.workItemId));
    // The version the item was created under, when the project has moved on (ADR 0370 §5).
    at.pinned = statements.length;
    statements.push(
      d1
        .prepare(
          `SELECT pp.raw, pp.valid, pp.error FROM core_work_items w
           JOIN core_projects p ON p.id = w.project_id
           JOIN core_project_policies pp ON pp.project_id = w.project_id AND pp.sha = w.policy_sha
           WHERE w.id = ? AND w.policy_sha IS NOT NULL AND w.policy_sha IS NOT p.policy_sha`,
        )
        .bind(ids.workItemId),
    );
  }
  if (projectExpr) {
    at.project = statements.length;
    statements.push(
      d1.prepare(`SELECT * FROM core_projects WHERE id = ${projectExpr.sql}`).bind(projectExpr.arg),
    );
    at.repositories = statements.length;
    statements.push(
      d1
        .prepare(
          `SELECT * FROM core_repositories WHERE project_id = ${projectExpr.sql} ORDER BY created_at, id`,
        )
        .bind(projectExpr.arg),
    );
    at.policy = statements.length;
    statements.push(
      d1
        .prepare(
          `SELECT pp.raw, pp.valid, pp.error FROM core_project_policies pp
           JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha
           WHERE p.id = ${projectExpr.sql}`,
        )
        .bind(projectExpr.arg),
    );
  }
  if (userId && orgExpr) {
    at.role = statements.length;
    statements.push(
      d1
        .prepare(
          `SELECT role FROM core_member WHERE user_id = ? AND organization_id = ${orgExpr.sql}`,
        )
        .bind(userId, orgExpr.arg),
    );
  }
  const results = statements.length > 0 ? await d1.batch(statements) : [];
  const first = <T>(i: number | undefined): T | null =>
    i === undefined ? null : ((results[i]?.results[0] as T | undefined) ?? null);

  const role = at.role === undefined ? undefined : (first<{ role: string }>(at.role)?.role ?? null);
  let orgId = ids.orgId;
  let projectId = ids.projectId;
  const workItem = first<WorkItemRow>(at.workItem);
  if (ids.workItemId) {
    if (!workItem) throw new OperationError("not_found", `no work item ${ids.workItemId}`);
    projectId = workItem.project_id;
    orgId = workItem.org_id;
  }
  const project = first<ProjectRow>(at.project);
  if (projectId) {
    if (!project) throw new OperationError("not_found", `no project ${projectId}`);
    orgId = project.org_id;
  }
  if (!project) return { ...EMPTY, orgId, workItemId: ids.workItemId, role };
  const repositories =
    at.repositories === undefined
      ? []
      : ((results[at.repositories]?.results ?? []) as unknown as RepositoryRow[]);
  const repository = pickRepository(repositories, workItem, ids.repositoryId);
  const raw = interpretPolicy(project, first<PolicyRow>(at.policy));
  const pinnedRow = first<PolicyRow>(at.pinned);
  const pinnedRaw = pinnedRow
    ? interpretPolicy({ policy_sha: workItem?.policy_sha ?? null }, pinnedRow).policy
    : null;
  // A read that uses none of what an org workflow decides (polled timelines, planning, the queue)
  // doesn't resolve it: the project's config as saved, and no org config read or parsed.
  const { policy, rawPolicy, policyError, pinnedPolicy } = skipOrgWorkflow
    ? {
        policy: raw.policy,
        rawPolicy: raw.policy,
        policyError: raw.policyError,
        pinnedPolicy: pinnedRaw,
      }
    : await withOrgWorkflow(db, project.org_id, raw, pinnedRaw, workItem, project.id);
  return {
    orgId,
    projectId,
    workItemId: ids.workItemId,
    workItem,
    project,
    repositories,
    repository,
    policy,
    rawPolicy,
    policySha: project.policy_sha,
    policyError,
    pinnedPolicy,
    role,
  };
}

/**
 * The project's policy as the factory runs it, and the item's pinned one (spec 52 PR (d)): a project
 * on an org workflow has it resolved in (`effectivePolicy`), under the org's current config version,
 * or for the item the version it pinned. Unresolvable fails closed, with the reason. A project not
 * on an org workflow reads nothing more.
 */
export async function withOrgWorkflow(
  db: Db,
  orgId: string,
  raw: { policy: ProjectPolicy | null; policyError: string | null },
  pinnedRaw: ProjectPolicy | null,
  workItem: Pick<WorkItemRow, "org_config_version"> | null,
  projectId: string | null = null,
): Promise<{
  policy: ProjectPolicy | null;
  rawPolicy: ProjectPolicy | null;
  policyError: string | null;
  pinnedPolicy: ProjectPolicy | null;
}> {
  const current = await resolveOrgWorkflow(db, orgId, raw.policy, null, projectId);
  const pinnedVersion = workItem?.org_config_version ?? null;
  const pinnedBase = pinnedRaw ?? (pinnedVersion !== null ? raw.policy : null);
  const pinned =
    pinnedBase && (pinnedRaw || onOrgWorkflow(pinnedBase))
      ? await resolveOrgWorkflow(db, orgId, pinnedBase, pinnedVersion, projectId)
      : null;
  return {
    policy: current.policy,
    rawPolicy: raw.policy,
    policyError: raw.policyError ?? current.error,
    pinnedPolicy: pinned?.policy ?? null,
  };
}

/**
 * Parsed and validated org config documents by `org:version`, per isolate. A version is immutable
 * once written, so an entry never goes stale; the map is bounded so an isolate serving many orgs
 * keeps only the most recent.
 */
const ORG_CONFIGS = new Map<string, OrgConfigParse>();
const ORG_CONFIG_CACHE_SIZE = 64;
type OrgConfigParse = ReturnType<typeof parseOrgConfig>;

/** For tests: forget every cached org config. */
export function clearOrgConfigCache() {
  ORG_CONFIGS.clear();
}

/** The org's config at `version`, parsed once per isolate (the document is up to 256 KiB). */
async function orgConfigAt(db: Db, orgId: string, version: number): Promise<OrgConfigParse> {
  const key = `${orgId}:${version}`;
  const hit = ORG_CONFIGS.get(key);
  if (hit) {
    // Most recently used last.
    ORG_CONFIGS.delete(key);
    ORG_CONFIGS.set(key, hit);
    return hit;
  }
  // A point read by primary key (org_id, version).
  const row = await db
    .selectFrom("core_org_configs")
    .select("raw")
    .where("org_id", "=", orgId)
    .where("version", "=", version)
    .executeTakeFirst();
  const parsed: OrgConfigParse = row
    ? parseOrgConfig(JSON.parse(row.raw))
    : { ok: true, config: EMPTY_ORG_CONFIG };
  if (!row) return parsed;
  ORG_CONFIGS.set(key, parsed);
  if (ORG_CONFIGS.size > ORG_CONFIG_CACHE_SIZE) {
    const oldest = ORG_CONFIGS.keys().next().value;
    if (oldest !== undefined) ORG_CONFIGS.delete(oldest);
  }
  return parsed;
}

/**
 * The org admins' approvals of a project's looser overrides for one org version
 * (`core_override_approvals`, by its primary key's prefix): stage → setting → the value approved.
 */
export async function overrideApprovals(
  db: Db,
  projectId: string,
  orgVersion: number,
): Promise<OverrideApprovals> {
  const rows = await db
    .selectFrom("core_override_approvals")
    .select(["stage_id", "setting", "value"])
    .where("project_id", "=", projectId)
    .where("org_version", "=", orgVersion)
    .limit(50)
    .execute();
  const out: OverrideApprovals = {};
  for (const r of rows) {
    try {
      out[r.stage_id] = { ...out[r.stage_id], [r.setting]: JSON.parse(r.value) as unknown };
    } catch {
      // A row that isn't JSON approves nothing.
    }
  }
  return out;
}

/** `policy` with its org workflow resolved under `version` (null: the org's current one). */
export async function resolveOrgWorkflow(
  db: Db,
  orgId: string,
  policy: ProjectPolicy | null,
  version: number | null,
  /** Whose override approvals apply; null: none (every looser override takes the stricter value). */
  projectId: string | null = null,
): Promise<{ policy: ProjectPolicy | null; error: string | null }> {
  if (!policy || !onOrgWorkflow(policy)) return { policy, error: null };
  // The org's current version is one point read of its row; the document is read and parsed only
  // the first time this isolate sees that version. Only for a project on an org workflow.
  const at =
    version ??
    (
      await db
        .selectFrom("core_organization")
        .select("config_version")
        .where("id", "=", orgId)
        .executeTakeFirst()
    )?.config_version ??
    null;
  const org =
    at === null
      ? { ok: true as const, config: EMPTY_ORG_CONFIG }
      : await orgConfigAt(db, orgId, at);
  if (!org.ok) return { policy: null, error: `the org config v${at} doesn't validate` };
  const approvals =
    projectId && at !== null && Object.keys(policy.workflowOverrides).length
      ? await overrideApprovals(db, projectId, at)
      : {};
  const effective = effectivePolicy(policy, org.config, approvals);
  return effective.ok
    ? { policy: effective.value, error: null }
    : { policy: null, error: `the project's workflow: ${effective.error}` };
}

/** The project's policy at its recorded default-branch SHA, or why there is none. */
export async function loadPolicy(
  db: Db,
  project: Pick<ProjectRow, "id" | "policy_sha">,
): Promise<{ policy: ProjectPolicy | null; policyError: string | null }> {
  if (!project.policy_sha) return interpretPolicy(project, null);
  const row = await db
    .selectFrom("core_project_policies")
    .select(["raw", "valid", "error"])
    .where("project_id", "=", project.id)
    .where("sha", "=", project.policy_sha)
    .executeTakeFirst();
  return interpretPolicy(project, row ?? null);
}

/** What a stored policy row means: the parsed policy, or why there is none (fails closed). */
function interpretPolicy(
  project: Pick<ProjectRow, "policy_sha">,
  row: PolicyRow | null,
): { policy: ProjectPolicy | null; policyError: string | null } {
  if (!project.policy_sha) {
    return { policy: null, policyError: "no .factory/policy.json synced from the default branch" };
  }
  if (!row) return { policy: null, policyError: `policy at ${project.policy_sha} not found` };
  if (!row.valid) return { policy: null, policyError: row.error ?? "malformed policy" };
  const parsed = parseProjectPolicy(row.raw);
  return parsed.ok
    ? { policy: parsed.policy, policyError: null }
    : { policy: null, policyError: parsed.error };
}

export interface KillState {
  scope: KillScope;
  scopeId: string;
  epoch: number;
}

/** The first kill switch that is on for this org/project (org first), or null. */
export async function activeKillSwitch(
  db: Db,
  orgId: string | null,
  projectId: string | null,
): Promise<KillState | null> {
  if (!orgId && !projectId) return null;
  const rows = await db
    .selectFrom("core_kill_switches")
    .select(["scope", "scope_id", "epoch"])
    .where("is_on", "=", 1)
    .where((eb) =>
      eb.or([
        eb.and([eb("scope", "=", "org"), eb("scope_id", "=", orgId ?? "")]),
        eb.and([eb("scope", "=", "project"), eb("scope_id", "=", projectId ?? "")]),
      ]),
    )
    .execute();
  const row = rows.find((r) => r.scope === "org") ?? rows[0];
  return row ? { scope: row.scope, scopeId: row.scope_id, epoch: row.epoch } : null;
}

/** The event that releases a step parked by this kill switch (spike ADR 0110). */
export function resumeEventType(kill: KillState): string {
  return `resume-${kill.scope}-${kill.scopeId}-${kill.epoch}`;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

export async function orgRole(db: Db, orgId: string, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("core_member")
    .select("role")
    .where("organization_id", "=", orgId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.role ?? null;
}

export async function isOrgAdmin(db: Db, orgId: string, userId: string): Promise<boolean> {
  const role = await orgRole(db, orgId, userId);
  return role !== null && ADMIN_ROLES.has(role);
}

/**
 * The project's approvers as user ids: `.factory/` `approvers` (GitHub logins or user ids), else
 * the org's owners and admins. Fails closed: a policy naming nobody known yields no approvers.
 */
export async function approverIds(
  db: Db,
  orgId: string,
  policy: Pick<ProjectPolicy, "approvers"> | null,
): Promise<string[]> {
  const named = policy?.approvers ?? [];
  if (named.length === 0) {
    const rows = await db
      .selectFrom("core_member")
      .select("user_id")
      .where("organization_id", "=", orgId)
      .where("role", "in", [...ADMIN_ROLES])
      .orderBy("created_at")
      .execute();
    return rows.map((r) => r.user_id);
  }
  const users = await db
    .selectFrom("core_user")
    .innerJoin("core_member", "core_member.user_id", "core_user.id")
    .select(["core_user.id", "core_user.github_login"])
    .where("core_member.organization_id", "=", orgId)
    .execute();
  const ids: string[] = [];
  for (const name of named) {
    const user = users.find((u) => u.id === name || u.github_login === name);
    if (user && !ids.includes(user.id)) ids.push(user.id);
  }
  return ids;
}

/** Who gets a gate or question that timed out (ADR 0042): the backup owner, else the first approver. */
export async function backupOwnerId(
  db: Db,
  orgId: string,
  policy: Pick<ProjectPolicy, "approvers" | "backupOwner"> | null,
): Promise<string | null> {
  const approvers = await approverIds(db, orgId, policy);
  if (policy?.backupOwner) {
    const user = await db
      .selectFrom("core_user")
      .select("id")
      .where((eb) =>
        eb.or([
          eb("id", "=", policy.backupOwner ?? ""),
          eb("github_login", "=", policy.backupOwner ?? ""),
        ]),
      )
      .executeTakeFirst();
    if (user) return user.id;
  }
  return approvers[0] ?? null;
}

/** Throws `forbidden` unless the human actor holds `permission` in the scope. */
export async function checkPermission(
  db: Db,
  actor: Actor,
  permission: "signed-in" | "member" | "approver" | "admin",
  scope: Scope,
  /** The actor's role in `scope.orgId` when the caller already read it (`resolveScope`'s batch). */
  knownRole?: string | null,
): Promise<void> {
  if (actor.type !== "human" || permission === "signed-in") return;
  if (!scope.orgId) throw new OperationError("forbidden", `${permission} needs an org to check`);
  const role = knownRole !== undefined ? knownRole : await orgRole(db, scope.orgId, actor.id);
  if (role === null) throw new OperationError("forbidden", "not a member of this org");
  if (permission === "member") return;
  if (permission === "admin") {
    if (!ADMIN_ROLES.has(role))
      throw new OperationError("forbidden", "needs an org owner or admin");
    return;
  }
  const approvers = await approverIds(db, scope.orgId, scope.policy);
  if (!approvers.includes(actor.id)) {
    throw new OperationError("forbidden", "not an approver on this project");
  }
}
