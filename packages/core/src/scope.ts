// What a call is about (the org its input names) and who may make it. Used by `invoke()` and by
// handlers that need the same answers.
import type { Db } from "@software-factory/db";
import type { Actor } from "./actors.ts";
import { OperationError } from "./errors.ts";
import type { Permission, Scope, ScopeRef } from "./operation.ts";

/** Reads the scope-naming field from an operation's input. */
export function defaultScopeRef(input: unknown): ScopeRef {
  if (typeof input !== "object" || input === null) return {};
  const orgId = (input as Record<string, unknown>).orgId;
  return { orgId: typeof orgId === "string" ? orgId : null };
}

export function resolveScope(ref: ScopeRef): Scope {
  return { orgId: ref.orgId ?? null };
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

/** Refuses a person without `permission` in the scope's org. Other actors pass (see `actors`). */
export async function checkPermission(
  db: Db,
  actor: Actor,
  permission: Permission,
  scope: Scope,
): Promise<void> {
  if (actor.type !== "human" || permission === "signed-in") return;
  if (!scope.orgId) throw new OperationError("forbidden", `${permission} needs an org to check`);
  const role = await orgRole(db, scope.orgId, actor.id);
  if (role === null) throw new OperationError("forbidden", "not a member of this org");
  if (permission === "admin" && !ADMIN_ROLES.has(role)) {
    throw new OperationError("forbidden", "needs an org owner or admin");
  }
}
