// Better Auth for the factory: organization + multi-session + passkey, stored in D1.
// Mirrors the CRM's packages/auth/src/better-auth.ts (same version, D1 passed straight in).
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { createAccessControl } from "better-auth/plugins/access";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const AUTH_BASE_PATH = "/api/auth";

/** Every signed-in account in one browser. Better Auth's own default is also 5. */
export const MAX_ACCOUNTS_PER_DEVICE = 5;

export interface AuthEnv {
  DB: D1Database;
  /** Signs session cookies. Required, at least 32 characters. */
  BETTER_AUTH_SECRET: string;
  /** The app's public origin. Also the passkey relying party. */
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** "true" turns on email + password (local dev and tests only). */
  AUTH_EMAIL_PASSWORD?: string;
}

// Factory permissions sit beside Better Auth's own org statements, so `hasPermission` checks both.
export const statements = {
  ...defaultStatements,
  factory: ["create", "update", "delete"],
  project: ["create", "update", "delete"],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  owner: ac.newRole({
    ...ownerAc.statements,
    factory: ["create", "update", "delete"],
    project: ["create", "update", "delete"],
  }),
  admin: ac.newRole({
    ...adminAc.statements,
    factory: ["create", "update"],
    project: ["create", "update", "delete"],
  }),
  member: ac.newRole({ ...memberAc.statements, project: ["create"] }),
};

/** Personal orgs get a deterministic id and slug so creating one is idempotent. */
export function personalOrgId(userId: string): string {
  return `personal_${userId}`;
}

/**
 * Creates the user's Personal org and their owner membership in one D1 batch (atomic), and does
 * nothing if it already exists. D1 has no interactive transactions, so this cannot share a
 * transaction with the user insert; callers re-run it to self-heal (see listAllOrgs).
 */
export async function ensurePersonalOrg(db: D1Database, userId: string): Promise<void> {
  const id = personalOrgId(userId);
  // Better Auth stores dates in D1 as ISO-8601 text; match it so reads parse the same way.
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO organization (id, name, slug, logo, metadata, createdAt, kind)
         VALUES (?, 'Personal', ?, NULL, NULL, ?, 'personal')`,
      )
      .bind(id, `personal-${userId.toLowerCase()}`, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt)
         VALUES (?, ?, ?, 'owner', ?)`,
      )
      .bind(id, id, userId, now),
  ]);
}

export function createAuth(env: AuthEnv) {
  const baseURL = env.BETTER_AUTH_URL;
  const rpID = baseURL ? new URL(baseURL).hostname : "localhost";
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
            // Without this GitHub silently reuses whichever GitHub user the browser is signed in
            // as, so "Add another account" would just sign the same person in again.
            prompt: "select_account" as const,
          },
        }
      : undefined;

  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    ...(baseURL ? { baseURL } : {}),
    basePath: AUTH_BASE_PATH,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: env.AUTH_EMAIL_PASSWORD === "true" },
    socialProviders: github ?? {},
    account: {
      // Personal (GitHub) and work (GitHub) are separate users; never auto-link by email.
      accountLinking: { enabled: false },
    },
    plugins: [
      organization({
        ac,
        roles,
        schema: {
          organization: {
            additionalFields: {
              // "personal" for the auto-created org, "team" otherwise. Not settable by clients.
              kind: { type: "string", required: false, defaultValue: "team", input: false },
            },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            // Personal orgs are only ever made by ensurePersonalOrg.
            if (org.slug?.startsWith("personal-")) {
              throw new Error("The personal- slug prefix is reserved");
            }
          },
        },
      }),
      multiSession({ maximumSessions: MAX_ACCOUNTS_PER_DEVICE }),
      passkey({
        rpID,
        rpName: "Software Factory",
        ...(baseURL ? { origin: new URL(baseURL).origin } : {}),
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensurePersonalOrg(env.DB, user.id);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
