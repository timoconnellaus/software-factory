// Resolving what a call is about (work item → project → org), the policy in force, kill switches
// and who the approvers are. Used by `invoke()` and by handlers that need the same answers.
import type { Db, KillScope } from "@software-factory/db";
import type { Actor } from "./actors.ts";
import { OperationError } from "./errors.ts";
import type { ProjectRow, Scope, ScopeRef, WorkItemRow } from "./operation.ts";
import { type ProjectPolicy, parseProjectPolicy } from "./policy/project-policy.ts";

const EMPTY: Scope = {
  orgId: null,
  projectId: null,
  workItemId: null,
  workItem: null,
  project: null,
  policy: null,
  policySha: null,
  policyError: null,
};

/** Reads the scope-naming fields from an operation's input. */
export function defaultScopeRef(input: unknown): ScopeRef {
  if (typeof input !== "object" || input === null) return {};
  const record = input as Record<string, unknown>;
  const pick = (k: string) => (typeof record[k] === "string" ? (record[k] as string) : null);
  return {
    workItemId: pick("workItemId"),
    projectId: pick("projectId"),
    orgId: pick("orgId"),
    jobId: pick("jobId"),
    questionId: pick("questionId"),
    pendingActionId: pick("pendingActionId"),
  };
}

export async function resolveScope(db: Db, ref: ScopeRef): Promise<Scope> {
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
  const { policy, policyError } = await loadPolicy(db, project);
  return {
    orgId,
    projectId,
    workItemId,
    workItem,
    project,
    policy,
    policySha: project.policy_sha,
    policyError,
  };
}

/** The project's policy at its recorded default-branch SHA, or why there is none. */
export async function loadPolicy(
  db: Db,
  project: Pick<ProjectRow, "id" | "policy_sha">,
): Promise<{ policy: ProjectPolicy | null; policyError: string | null }> {
  if (!project.policy_sha) {
    return { policy: null, policyError: "no .factory/policy.json synced from the default branch" };
  }
  const row = await db
    .selectFrom("core_project_policies")
    .select(["raw", "valid", "error"])
    .where("project_id", "=", project.id)
    .where("sha", "=", project.policy_sha)
    .executeTakeFirst();
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
): Promise<void> {
  if (actor.type !== "human" || permission === "signed-in") return;
  if (!scope.orgId) throw new OperationError("forbidden", `${permission} needs an org to check`);
  const role = await orgRole(db, scope.orgId, actor.id);
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
