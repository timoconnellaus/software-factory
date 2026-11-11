import { env } from "cloudflare:test";
import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import type { AccountView } from "../src/server/api.ts";
import { createAuth, personalOrgId } from "../src/server/auth.ts";
import { authEnv, Browser, email } from "./helpers.ts";

/** A browser signed in to a personal account and then a work account that owns "Work Co". */
async function personalAndWork() {
  const browser = new Browser();
  const personalEmail = email("personal");
  const workEmail = email("work");
  const personal = await browser.signUp(personalEmail);
  expect(personal.status).toBe(200);
  // "Add another account": sign in again in the same browser (cookies included).
  const work = await browser.signUp(workEmail);
  expect(work.status).toBe(200);
  const personalId = personal.body.user.id;
  const workId = work.body.user.id;

  const created = await browser.json<{ id: string }>("/api/factory/orgs", {
    body: { accountUserId: workId, name: "Work Co" },
  });
  expect(created.status).toBe(201);
  return { browser, personalId, workId, workOrgId: created.body.id, personalEmail, workEmail };
}

describe("schema", () => {
  it("the committed migrations match the Better Auth config exactly", async () => {
    const auth = createAuth(authEnv);
    const { toBeCreated, toBeAdded } = await getMigrations(auth.options);
    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);
  });
});

describe("personal org", () => {
  it("is created for every new user, owned by them", async () => {
    const browser = new Browser();
    const { body } = await browser.signUp(email("solo"));
    const row = await env.DB.prepare(
      `SELECT o.name, o.kind, m.role FROM organization o JOIN member m ON m.organizationId = o.id
       WHERE m.userId = ?`,
    )
      .bind(body.user.id)
      .all<{ name: string; kind: string; role: string }>();
    expect(row.results).toEqual([{ name: "Personal", kind: "personal", role: "owner" }]);
  });

  it("re-creating it is a no-op (idempotent, self-healing)", async () => {
    const browser = new Browser();
    const { body } = await browser.signUp(email("heal"));
    await env.DB.prepare("DELETE FROM organization WHERE id = ?")
      .bind(personalOrgId(body.user.id))
      .run();
    const { body: views } = await browser.json<AccountView[]>("/api/factory/orgs");
    expect(views[0]?.orgs.map((o) => o.kind)).toEqual(["personal"]);
  });

  it("clients can't claim the reserved personal- slug", async () => {
    const browser = new Browser();
    await browser.signUp(email("squat"));
    const res = await browser.fetch("/api/auth/organization/create", {
      body: { name: "Fake", slug: "personal-someone-else" },
    });
    expect(res.ok).toBe(false);
  });
});

describe("all orgs across device sessions", () => {
  it("lists every account's orgs, each tagged with its account", async () => {
    const { browser, personalId, workId, workOrgId } = await personalAndWork();
    const { status, body } = await browser.json<AccountView[]>("/api/factory/orgs");
    expect(status).toBe(200);

    const byUser = new Map(body.map((v) => [v.account.userId, v]));
    expect([...byUser.keys()].sort()).toEqual([personalId, workId].sort());

    const personal = byUser.get(personalId);
    const work = byUser.get(workId);
    expect(personal?.orgs.map((o) => o.name)).toEqual(["Personal"]);
    expect(work?.orgs.map((o) => o.name)).toEqual(["Personal", "Work Co"]);
    expect(work?.orgs.find((o) => o.id === workOrgId)?.role).toBe("owner");
    for (const view of body) {
      for (const org of view.orgs) expect(org.accountUserId).toBe(view.account.userId);
    }
    // The last sign-in is the active account.
    expect(work?.account.active).toBe(true);
    expect(personal?.account.active).toBe(false);
  });

  it("does not leak session tokens to the browser", async () => {
    const { browser } = await personalAndWork();
    const res = await browser.fetch("/api/factory/orgs");
    const text = await res.text();
    for (const [name, value] of browser.cookies) {
      if (name.includes("session_token")) {
        expect(text).not.toContain(decodeURIComponent(value).split(".")[0]);
      }
    }
  });

  it("returns nothing for a browser with no accounts", async () => {
    const { status, body } = await new Browser().json<AccountView[]>("/api/factory/orgs");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe("actions run under the item's own session", () => {
  it("creates a factory as the account that owns the org", async () => {
    const { browser, workId, workOrgId } = await personalAndWork();
    const res = await browser.json<{ id: string }>("/api/factory/factories", {
      body: { accountUserId: workId, organizationId: workOrgId, name: "platform" },
    });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT organizationId, createdBy FROM factory WHERE id = ?")
      .bind(res.body.id)
      .first();
    expect(row).toEqual({ organizationId: workOrgId, createdBy: workId });
  });

  it("refuses the action under the wrong account, even though both are signed in", async () => {
    const { browser, personalId, workOrgId } = await personalAndWork();
    // Personal is not a member of Work Co. The work session sits in the same cookie jar.
    const res = await browser.json<{ error: string }>("/api/factory/factories", {
      body: { accountUserId: personalId, organizationId: workOrgId, name: "sneaky" },
    });
    expect(res.status).toBe(403);

    // ...and also when the personal account is the active one.
    expect(
      (await browser.fetch("/api/factory/switch", { body: { accountUserId: personalId } })).status,
    ).toBe(200);
    const again = await browser.json("/api/factory/factories", {
      body: { accountUserId: personalId, organizationId: workOrgId, name: "sneaky" },
    });
    expect(again.status).toBe(403);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM factory WHERE name = 'sneaky'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("works for the right account even when another account is active", async () => {
    const { browser, personalId, workId, workOrgId } = await personalAndWork();
    await browser.fetch("/api/factory/switch", { body: { accountUserId: personalId } });
    const res = await browser.json("/api/factory/factories", {
      body: { accountUserId: workId, organizationId: workOrgId, name: "while-personal-active" },
    });
    expect(res.status).toBe(201);
  });

  it("refuses an account that isn't signed in on this device", async () => {
    const other = new Browser();
    const { body: stranger } = await other.signUp(email("stranger"));
    const { browser, workOrgId } = await personalAndWork();
    const res = await browser.json("/api/factory/factories", {
      body: { accountUserId: stranger.user.id, organizationId: workOrgId, name: "x" },
    });
    expect(res.status).toBe(401);
  });

  it("ignores a forged _multi- cookie", async () => {
    const victim = await personalAndWork();
    const attacker = new Browser();
    await attacker.signUp(email("attacker"));
    // Copy the cookie *name* for the work session but sign it with nothing.
    const multi = [...victim.browser.cookies.keys()].find((k) => k.includes("_multi-"));
    expect(multi).toBeDefined();
    const token = multi?.split("_multi-")[1] ?? "";
    attacker.cookies.set(multi ?? "", `${token}.forged-signature`);
    const res = await attacker.json("/api/factory/factories", {
      body: { accountUserId: victim.workId, organizationId: victim.workOrgId, name: "forged" },
    });
    expect(res.status).toBe(401);
  });
});

describe("switching and signing out one account", () => {
  it("switch changes only the active account; each session keeps its own active org", async () => {
    const { browser, personalId, workId, workOrgId } = await personalAndWork();
    // Set work's active org via the Better Auth client endpoint (acts on the active session).
    await browser.fetch("/api/auth/organization/set-active", {
      body: { organizationId: workOrgId },
    });
    await browser.fetch("/api/factory/switch", { body: { accountUserId: personalId } });

    const { body } = await browser.json<AccountView[]>("/api/factory/orgs");
    const personal = body.find((v) => v.account.userId === personalId);
    const work = body.find((v) => v.account.userId === workId);
    expect(personal?.account.active).toBe(true);
    expect(work?.account.active).toBe(false);
    expect(work?.orgs.find((o) => o.id === workOrgId)?.active).toBe(true);
    expect(personal?.orgs.some((o) => o.active)).toBe(false);
  });

  it("signing one account out leaves the other signed in", async () => {
    const { browser, personalId, workId } = await personalAndWork();
    const res = await browser.fetch("/api/factory/sign-out-account", {
      body: { accountUserId: workId },
    });
    expect(res.status).toBe(200);
    const { body } = await browser.json<AccountView[]>("/api/factory/orgs");
    expect(body.map((v) => v.account.userId)).toEqual([personalId]);
    // The active account fell back to the remaining one.
    expect(body[0]?.account.active).toBe(true);
  });
});

describe("limits", () => {
  it("a sixth account signs in and becomes active but is NOT kept as a device session", async () => {
    const browser = new Browser();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await browser.signUp(email(`acct${i}`))).body.user.id);
    const { body } = await browser.json<AccountView[]>("/api/factory/orgs");
    // Better Auth's multi-session plugin silently skips the _multi- cookie past maximumSessions.
    expect(body).toHaveLength(5);
    expect(body.map((v) => v.account.userId)).not.toContain(ids[5]);
    const active = await browser.json<{ user: { id: string } }>("/api/auth/get-session");
    expect(active.body.user.id).toBe(ids[5]);
  });
});
