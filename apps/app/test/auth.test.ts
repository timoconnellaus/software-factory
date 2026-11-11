import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth, ensurePersonalOrg, isAllowed, userFromRequest } from "#/server/auth";
import { recordingEngine, signIn, testEnv, uid } from "./helpers.ts";

async function orgsOf(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT o.name, o.kind, m.role FROM core_member m JOIN core_organization o ON o.id = m.organization_id
     WHERE m.user_id = ?`,
  )
    .bind(userId)
    .all<{ name: string; kind: string; role: string }>();
  return results;
}

describe("the allowlist", () => {
  it("matches GitHub logins case-insensitively and lets nobody in when empty", () => {
    const list = { ALLOWED_GITHUB_LOGINS: " timoconnellaus , other " };
    expect(isAllowed(list, "TimOConnellAus")).toBe(true);
    expect(isAllowed(list, "other")).toBe(true);
    expect(isAllowed(list, "mallory")).toBe(false);
    expect(isAllowed(list, undefined)).toBe(false);
    expect(isAllowed({ ALLOWED_GITHUB_LOGINS: "" }, "timoconnellaus")).toBe(false);
    expect(isAllowed({}, "timoconnellaus")).toBe(false);
  });
});

describe("GitHub sign-in", () => {
  it("fills github_login and gives a new user exactly one org, named Personal, as its owner", async () => {
    const login = uid("gh-");
    const appEnv = testEnv(recordingEngine().engine, login);
    const { user, headers } = await signIn(appEnv, login);
    const row = await env.DB.prepare("SELECT github_login FROM core_user WHERE id = ?")
      .bind(user.id)
      .first<{ github_login: string }>();
    expect(row?.github_login).toBe(login);
    expect(await orgsOf(user.id)).toEqual([{ name: "Personal", kind: "personal", role: "owner" }]);
    // Signing in again doesn't make a second one.
    await ensurePersonalOrg(env.DB, user.id);
    expect(await orgsOf(user.id)).toHaveLength(1);
    const me = await userFromRequest(appEnv, headers);
    expect(me).toMatchObject({ id: user.id, githubLogin: login });
  });

  it("refuses a GitHub account that isn't on the allowlist: no user row is created", async () => {
    const appEnv = testEnv(recordingEngine().engine, "timoconnellaus");
    const login = uid("mallory-");
    await expect(signIn(appEnv, login)).rejects.toThrow(/allowlist/);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_user WHERE github_login = ?")
      .bind(login)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("locks out a signed-in user whose login is removed from the allowlist", async () => {
    const login = uid("gh-");
    const allowed = testEnv(recordingEngine().engine, login);
    const { user, headers } = await signIn(allowed, login);
    const removed = testEnv(recordingEngine().engine, "someone-else");
    expect(await userFromRequest(removed, headers)).toBeNull();
    // And they can't start a new session either.
    const ctx = await createAuth(removed).$context;
    await expect(ctx.internalAdapter.createSession(user.id)).rejects.toThrow(/allowlist/);
  });

  it("only offers GitHub: email sign-up and profile edits are off", async () => {
    const appEnv = testEnv(recordingEngine().engine, uid("gh-"));
    const auth = createAuth(appEnv);
    const signUp = await auth.handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ email: "a@example.com", password: "password123", name: "A" }),
      }),
    );
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    const update = await auth.handler(
      new Request("http://localhost/api/auth/update-user", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ githubLogin: "timoconnellaus" }),
      }),
    );
    expect(update.status).toBe(404);
  });
});
