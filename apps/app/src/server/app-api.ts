// What the server functions do, framework-free so it is tested directly in workerd. fns.ts wraps
// each in a TanStack Start server function; the browser never talks to D1 or sf-engine itself.
import { z } from "zod";
import { APP_OPERATIONS, type OpResult } from "#/lib/ops";
import { type AuthEnv, type SignedInUser, userFromRequest } from "./auth.ts";
import { type EngineRpc, invokeAs, type OpTiming } from "./engine.ts";

export interface AppEnv extends AuthEnv {
  ENGINE: EngineRpc;
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

/**
 * What a server function spent its time on, for the `Server-Timing` header: resolving the session
 * (`auth`, plus `orgs` for the session's orgs) and each engine call (`op`, with the part spent
 * inside the engine as `engine`).
 */
export class Timings {
  readonly ops: OpTiming[] = [];
  private readonly spans: { name: string; ms: number }[] = [];

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.spans.push({ name, ms: Math.round((performance.now() - start) * 10) / 10 });
    }
  }

  header(): string {
    return [
      ...this.spans.map((s) => `${s.name};dur=${s.ms}`),
      ...this.ops.flatMap((o, i) => [
        `op${i};desc="${o.name}";dur=${o.ms}`,
        ...(o.engineMs === null ? [] : [`engine${i};desc="${o.name} in engine";dur=${o.engineMs}`]),
      ]),
    ].join(", ");
  }
}

export async function runOp(
  env: AppEnv,
  headers: Headers,
  raw: unknown,
  timings = new Timings(),
): Promise<OpResult> {
  const call = opCallSchema.safeParse(raw);
  if (!call.success) return { ok: false, code: "invalid_input", message: "unknown operation" };
  const user = await timings.time("auth", () => userFromRequest(env, headers));
  if (!user) return UNAUTHENTICATED;
  return invokeAs(
    env.ENGINE,
    user.id,
    call.data.name,
    call.data.input,
    call.data.idempotencyKey,
    timings.ops,
  );
}

export interface SessionInfo {
  user: SignedInUser;
  orgs: { id: string; name: string; kind: string; role: string }[];
  /** The Personal org (every user has one). */
  personalOrgId: string | null;
}

/** The signed-in user and their orgs (Better Auth's tables), or null. */
export async function sessionInfo(
  env: AppEnv,
  headers: Headers,
  timings = new Timings(),
): Promise<SessionInfo | null> {
  const user = await timings.time("auth", () => userFromRequest(env, headers));
  if (!user) return null;
  const { results } = await timings.time("orgs", () =>
    env.DB.prepare(
      `SELECT o.id, o.name, o.kind, m.role FROM core_member m
     JOIN core_organization o ON o.id = m.organization_id
     WHERE m.user_id = ? ORDER BY o.kind = 'personal' DESC, o.created_at`,
    )
      .bind(user.id)
      .all<{ id: string; name: string; kind: string; role: string }>(),
  );
  return {
    user,
    orgs: results,
    personalOrgId: results.find((o) => o.kind === "personal")?.id ?? null,
  };
}
