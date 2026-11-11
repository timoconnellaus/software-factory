import { env } from "cloudflare:workers";
import type { AppEnv } from "#/server/app-api";
import { createAuth } from "#/server/auth";
import type { EngineRpc } from "#/server/engine";

let n = 0;
export const uid = (p = "") => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export interface Call {
  name: string;
  input: unknown;
  options: Parameters<EngineRpc["invoke"]>[2];
}

/** An engine that records every call and answers from `reply` (default: ok with `{}`). */
export function recordingEngine(
  reply: (name: string, input: unknown) => Awaited<ReturnType<EngineRpc["invoke"]>> = () => ({
    ok: true,
    result: { status: "ok", output: {}, auditId: null },
  }),
) {
  const calls: Call[] = [];
  const engine: EngineRpc = {
    async invoke(name, input, options) {
      calls.push({ name, input, options });
      return reply(name, input);
    },
  };
  return { engine, calls };
}

export function testEnv(engine: EngineRpc, allowed = "timoconnellaus"): AppEnv {
  return {
    DB: env.DB,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: "http://localhost",
    GH_APP_CLIENT_ID: "client",
    GH_APP_CLIENT_SECRET: env.GH_APP_CLIENT_SECRET,
    ALLOWED_GITHUB_LOGINS: allowed,
    ENGINE: engine,
  };
}

/** Better Auth's signed session cookie for a token (better-call's HMAC-SHA256, base64). */
async function signed(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`);
}

/**
 * Creates a user through Better Auth (so its database hooks run, as on a GitHub sign-in) and a
 * session, and returns request headers carrying the session cookie.
 */
export async function signIn(appEnv: AppEnv, login: string) {
  const auth = createAuth(appEnv);
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser(
    {
      name: login,
      email: `${uid()}+${login}@users.noreply.github.com`,
      emailVerified: true,
      githubLogin: login,
    },
    { method: "oauth", oauth: { providerId: "github" } },
  );
  const session = await ctx.internalAdapter.createSession(user.id);
  const headers = new Headers({
    cookie: `better-auth.session_token=${await signed(session.token, appEnv.BETTER_AUTH_SECRET as string)}`,
  });
  return { user, session, headers };
}
