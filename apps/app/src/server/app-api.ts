// What the server functions do, framework-free so it is tested directly in workerd. fns.ts wraps
// each in a TanStack Start server function; the browser never talks to D1 or sf-engine itself.
import { z } from "zod";
import { APP_OPERATIONS, type OpResult } from "#/lib/ops";
import { type AuthEnv, type SignedInUser, userFromRequest } from "./auth.ts";
import { type EngineRpc, invokeAs } from "./engine.ts";

export interface AppEnv extends AuthEnv {
  ENGINE: EngineRpc;
  PUBLIC_BASE_URL?: string;
}

/** Narrows the generated Env (ENGINE is a plain Service there) to what the server code uses. */
export function appEnv(env: unknown): AppEnv {
  return env as AppEnv;
}

export const opCallSchema = z.object({
  name: z.enum(APP_OPERATIONS),
  input: z.unknown(),
  /** A client-generated key per form submit, so a retried submit runs once. */
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type OpCall = z.infer<typeof opCallSchema>;

const UNAUTHENTICATED: OpResult = {
  ok: false,
  code: "unauthenticated",
  message: "Your session has ended. Sign in again.",
};

export async function runOp(env: AppEnv, headers: Headers, raw: unknown): Promise<OpResult> {
  const call = opCallSchema.safeParse(raw);
  if (!call.success) return { ok: false, code: "invalid_input", message: "unknown operation" };
  const user = await userFromRequest(env, headers);
  if (!user) return UNAUTHENTICATED;
  return invokeAs(env.ENGINE, user.id, call.data.name, call.data.input, call.data.idempotencyKey);
}

export interface SessionInfo {
  user: SignedInUser;
  orgs: { id: string; name: string; kind: string; role: string }[];
  /** The Personal org (every user has one). */
  personalOrgId: string | null;
}

/** The signed-in user and their orgs (Better Auth's tables), or null. */
export async function sessionInfo(env: AppEnv, headers: Headers): Promise<SessionInfo | null> {
  const user = await userFromRequest(env, headers);
  if (!user) return null;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.name, o.kind, m.role FROM core_member m
     JOIN core_organization o ON o.id = m.organization_id
     WHERE m.user_id = ? ORDER BY o.kind = 'personal' DESC, o.created_at`,
  )
    .bind(user.id)
    .all<{ id: string; name: string; kind: string; role: string }>();
  return {
    user,
    orgs: results,
    personalOrgId: results.find((o) => o.kind === "personal")?.id ?? null,
  };
}
