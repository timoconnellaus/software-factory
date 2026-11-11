// Better Auth (ADR 0024): GitHub sign-in through the org's GitHub App (its OAuth client), stored in
// the core_* tables mapped as packages/db/README.md describes. Better Auth writes only its own
// tables; the Personal org it creates on first sign-in is Better Auth data too (core_organization,
// core_member). Everything else is written through operations on sf-engine.
//
// V1 has one user (docs/v1-scope.md): only GitHub logins in ALLOWED_GITHUB_LOGINS may sign in. An
// empty list lets nobody in.
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";

export const AUTH_BASE_PATH = "/api/auth";

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GH_APP_CLIENT_ID?: string;
  GH_APP_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_LOGINS?: string;
}

export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

/** The allowlist, lower-cased. GitHub logins are case-insensitive. */
export function allowedLogins(env: Pick<AuthEnv, "ALLOWED_GITHUB_LOGINS">): Set<string> {
  return new Set(
    (env.ALLOWED_GITHUB_LOGINS ?? "")
      .split(",")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowed(env: Pick<AuthEnv, "ALLOWED_GITHUB_LOGINS">, login: unknown): boolean {
  return typeof login === "string" && allowedLogins(env).has(login.toLowerCase());
}

const NOT_ALLOWED = "This factory is private: your GitHub account is not on its allowlist.";

const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

/**
 * Creates the user's Personal org (kind `personal`, the user as `owner`) unless they have one.
 * Idempotent: a second call is a no-op.
 */
export async function ensurePersonalOrg(db: D1Database, userId: string): Promise<string> {
  const existing = await db
    .prepare(
      `SELECT o.id FROM core_organization o JOIN core_member m ON m.organization_id = o.id
       WHERE m.user_id = ? AND o.kind = 'personal' LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const orgId = `org_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO core_organization (id, name, slug, kind, created_at)
         VALUES (?, 'Personal', ?, 'personal', ?)`,
      )
      .bind(orgId, `personal-${orgId.slice(4, 16)}`, now),
    db
      .prepare(
        `INSERT INTO core_member (id, organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'owner', ?)`,
      )
      .bind(`mem_${crypto.randomUUID().replaceAll("-", "")}`, orgId, userId, now),
  ]);
  return orgId;
}

export function createAuth(env: AuthEnv) {
  if (!env.BETTER_AUTH_SECRET) throw new AuthConfigError("BETTER_AUTH_SECRET is not set");
  const db = env.DB;
  return betterAuth({
    database: db,
    secret: env.BETTER_AUTH_SECRET,
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    basePath: AUTH_BASE_PATH,
    telemetry: { enabled: false },
    // Users can't edit their own profile: github_login decides who is an approver (.factory/
    // names approvers by login), so it is set from GitHub only.
    disabledPaths: ["/update-user", "/change-email", "/delete-user"],
    socialProviders:
      env.GH_APP_CLIENT_ID && env.GH_APP_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GH_APP_CLIENT_ID,
              clientSecret: env.GH_APP_CLIENT_SECRET,
              mapProfileToUser: (profile) => ({
                githubLogin: profile.login,
                // A GitHub App can't always read the email; the noreply address keeps sign-in
                // working (Better Auth needs one).
                email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
              }),
            },
          }
        : {},
    user: {
      modelName: "core_user",
      fields: { emailVerified: "email_verified", ...timestamps },
      additionalFields: {
        githubLogin: { type: "string", required: false, fieldName: "github_login" },
      },
    },
    session: {
      modelName: "core_session",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        ...timestamps,
      },
    },
    account: {
      modelName: "core_account",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        ...timestamps,
      },
    },
    verification: {
      modelName: "core_verification",
      fields: { expiresAt: "expires_at", ...timestamps },
    },
    databaseHooks: {
      user: {
        create: {
          // Nobody off the allowlist gets a user row.
          before: async (user) => {
            if (!isAllowed(env, (user as { githubLogin?: unknown }).githubLogin)) {
              throw new APIError("FORBIDDEN", { message: NOT_ALLOWED });
            }
            return { data: user };
          },
          // Every user gets a Personal org (spec 10, criterion 2).
          after: async (user) => {
            await ensurePersonalOrg(db, user.id);
          },
        },
      },
      session: {
        create: {
          // Checked on every sign-in, so removing a login from the list locks them out.
          before: async (session) => {
            const row = await db
              .prepare("SELECT github_login FROM core_user WHERE id = ?")
              .bind(session.userId)
              .first<{ github_login: string | null }>();
            if (!isAllowed(env, row?.github_login)) {
              throw new APIError("FORBIDDEN", { message: NOT_ALLOWED });
            }
            await ensurePersonalOrg(db, session.userId);
            return { data: session };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const cache = new WeakMap<object, Auth>();

/** Better Auth for this env, built once per isolate. */
export function getAuth(env: AuthEnv): Auth {
  let auth = cache.get(env);
  if (!auth) {
    auth = createAuth(env);
    cache.set(env, auth);
  }
  return auth;
}

export interface SignedInUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  githubLogin: string | null;
}

/** The signed-in user for a request, or null. Re-checks the allowlist on every request. */
export async function userFromRequest(
  env: AuthEnv,
  headers: Headers,
): Promise<SignedInUser | null> {
  const session = await getAuth(env).api.getSession({ headers });
  if (!session) return null;
  const user = session.user as typeof session.user & { githubLogin?: string | null };
  if (!isAllowed(env, user.githubLogin)) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    githubLogin: user.githubLogin ?? null,
  };
}
