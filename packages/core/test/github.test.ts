// Connecting GitHub (ADR 0055): a single-use state, the installation verified as the App and
// against the person, and the record kept current by the installation webhooks.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { fakeUserToken } from "../src/testing/index.ts";
import { call, connect, first, numericId, ok, refusal, rows, services, uid } from "./helpers.ts";

const github = services.github;
const INTAKE = { type: "intake", id: "github" } as const;

/** A user with an org and no GitHub connection yet. */
async function person(login = uid("tim-")) {
  const userId = uid("usr_");
  const orgId = uid("org_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, 'Tim', ?, ?, ?, ?)",
    ).bind(userId, `${userId}@example.com`, login, now, now),
    env.DB.prepare(
      "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, 'Personal', ?, 'personal', ?)",
    ).bind(orgId, orgId, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(uid("mem_"), orgId, userId, now),
  ]);
  return { userId, orgId, login, human: { type: "human" as const, id: userId } };
}
type Person = Awaited<ReturnType<typeof person>>;

/** The App installed on the person's own account, with one repo. */
async function installOnOwnAccount(p: Person, repoName = uid("repo-")) {
  const installationId = numericId();
  const repoId = Number(numericId());
  await github.putInstallation({
    installationId,
    account: { login: p.login, type: "User" },
    repos: [{ id: repoId, owner: p.login, name: repoName, private: true, defaultBranch: "main" }],
  });
  return { installationId, repoId, repoName };
}

const start = (p: Person) =>
  ok<{ url: string; state: string }>("github.connectStart", { orgId: p.orgId }, p.human);

type Connected = {
  outcome: string;
  orgId: string | null;
  installation: { id: string; account: string; status: string; manageUrl: string } | null;
};

describe("Connect GitHub: the state", () => {
  it("sends the person to GitHub's install page with a state stored only as its hash", async () => {
    const p = await person();
    const s = await start(p);
    expect(s.url).toBe(
      `https://github.com/apps/software-factory-test/installations/new?state=${encodeURIComponent(s.state)}`,
    );
    const stored = await rows<{ state_hash: string }>(
      "SELECT state_hash FROM core_github_connect_states WHERE org_id = ?",
      p.orgId,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state_hash).not.toContain(s.state);
    const audit = await first<{ result: string }>(
      "SELECT result FROM core_audit WHERE operation = 'github.connectStart' AND org_id = ? ORDER BY at DESC LIMIT 1",
      p.orgId,
    );
    expect(audit.result).not.toContain(s.state);
  });

  it("connects an installation on the person's own account, once per state", async () => {
    const p = await person();
    const { installationId } = await installOnOwnAccount(p);
    const s = await start(p);
    const done = await ok<Connected>(
      "github.connectInstallation",
      { installationId, setupAction: "install", state: s.state },
      p.human,
    );
    expect(done).toMatchObject({
      outcome: "connected",
      orgId: p.orgId,
      installation: {
        account: p.login,
        status: "active",
        manageUrl: `https://github.com/settings/installations/${installationId}`,
      },
    });
    const again = await refusal(
      call("github.connectInstallation", { installationId, state: s.state }, p.human),
    );
    expect(again.code).toBe("forbidden");
    expect(again.message).toMatch(/already used/);
  });

  it("refuses a state another person started (CSRF), an unknown one and an expired one", async () => {
    const victim = await person();
    const attacker = await person();
    const { installationId } = await installOnOwnAccount(attacker);
    const s = await start(attacker);
    const csrf = await refusal(
      call("github.connectInstallation", { installationId, state: s.state }, victim.human),
    );
    expect(csrf.code).toBe("forbidden");
    expect(csrf.message).toMatch(/started by someone else/);
    expect(
      await rows("SELECT 1 FROM core_github_installations WHERE org_id = ?", victim.orgId),
    ).toHaveLength(0);

    const unknown = await refusal(
      call("github.connectInstallation", { installationId, state: "x".repeat(43) }, attacker.human),
    );
    expect(unknown.message).toMatch(/unknown state/);

    const late = await start(attacker);
    await env.DB.prepare(
      "UPDATE core_github_connect_states SET expires_at = '2000-01-01T00:00:00.000Z' WHERE org_id = ? AND used_at IS NULL",
    )
      .bind(attacker.orgId)
      .run();
    const expired = await refusal(
      call("github.connectInstallation", { installationId, state: late.state }, attacker.human),
    );
    expect(expired.message).toMatch(/expired/);
  });

  it("is for org owners and admins", async () => {
    const p = await person();
    const other = await person();
    const r = await refusal(call("github.connectStart", { orgId: p.orgId }, other.human));
    expect(r.code).toBe("forbidden");
  });
});

describe("Connect GitHub: verifying the installation", () => {
  it("refuses an installation id GitHub doesn't know for the App (forged)", async () => {
    const p = await person();
    const s = await start(p);
    const r = await refusal(
      call("github.connectInstallation", { installationId: "999999999", state: s.state }, p.human),
    );
    expect(r.code).toBe("not_found");
    expect(
      await rows("SELECT 1 FROM core_github_installations WHERE org_id = ?", p.orgId),
    ).toHaveLength(0);
  });

  it("refuses someone else's real installation (forged id from another account)", async () => {
    const p = await person();
    const stranger = await person();
    const theirs = await installOnOwnAccount(stranger);
    const s = await start(p);
    const r = await refusal(
      call(
        "github.connectInstallation",
        {
          installationId: theirs.installationId,
          state: s.state,
          userAccessToken: fakeUserToken(p.login),
        },
        p.human,
      ),
    );
    expect(r.code).toBe("forbidden");
    expect(r.message).toMatch(/doesn't have access/);
  });

  it("accepts an organization's installation only when the person's own token lists it", async () => {
    const p = await person();
    const installationId = numericId();
    await github.putInstallation({
      installationId,
      account: { login: uid("acme-"), type: "Organization" },
      members: [p.login],
    });
    const s1 = await start(p);
    const without = await refusal(
      call("github.connectInstallation", { installationId, state: s1.state }, p.human),
    );
    expect(without.code).toBe("forbidden");
    const s2 = await start(p);
    const done = await ok<Connected>(
      "github.connectInstallation",
      { installationId, state: s2.state, userAccessToken: fakeUserToken(p.login) },
      p.human,
    );
    expect(done.installation?.manageUrl).toMatch(
      /\/organizations\/acme-.*\/settings\/installations\//,
    );
    const audit = await first<{ input: string }>(
      "SELECT input FROM core_audit WHERE operation = 'github.connectInstallation' AND org_id = ? AND outcome = 'ok'",
      p.orgId,
    );
    expect(audit.input).not.toContain("ghu_fake_");
  });

  it("refreshes a connected installation from GitHub's update redirect, for its org's admins only", async () => {
    const p = await person();
    const { installationId } = await installOnOwnAccount(p);
    const s = await start(p);
    await ok("github.connectInstallation", { installationId, state: s.state }, p.human);
    await github.putInstallation({
      installationId,
      account: { login: p.login, type: "User" },
      repositorySelection: "all",
    });
    const updated = await ok<Connected>(
      "github.connectInstallation",
      { installationId, setupAction: "update" },
      p.human,
    );
    expect(updated.outcome).toBe("updated");
    const row = await first<{ repository_selection: string }>(
      "SELECT repository_selection FROM core_github_installations WHERE installation_id = ?",
      installationId,
    );
    expect(row.repository_selection).toBe("all");

    const outsider = await person();
    const r = await refusal(
      call("github.connectInstallation", { installationId, setupAction: "update" }, outsider.human),
    );
    expect(r.code).toBe("forbidden");

    // Connecting it to a second org is refused.
    const s2 = await start(outsider);
    const twice = await refusal(
      call("github.connectInstallation", { installationId, state: s2.state }, outsider.human),
    );
    expect(twice.code).toBe("conflict");
  });

  it("refuses an installation it never asked for, and records nothing for an owner-approval request", async () => {
    const p = await person();
    const { installationId } = await installOnOwnAccount(p);
    const unasked = await refusal(
      call("github.connectInstallation", { installationId, setupAction: "install" }, p.human),
    );
    expect(unasked.code).toBe("forbidden");
    const s = await start(p);
    const requested = await ok<Connected>(
      "github.connectInstallation",
      { installationId, setupAction: "request", state: s.state },
      p.human,
    );
    expect(requested).toMatchObject({ outcome: "requested", installation: null });
    expect(
      await rows("SELECT 1 FROM core_github_installations WHERE org_id = ?", p.orgId),
    ).toHaveLength(0);
  });
});

describe("the installation webhooks keep the record current", () => {
  it("suspends, unsuspends, changes the selection and deletes", async () => {
    const p = await person();
    const { installationId, recordId } = await connect(p.human, p.orgId, "acme");
    const base = { installationId, account: "acme" };
    const status = async () =>
      first<{ status: string; repository_selection: string }>(
        "SELECT status, repository_selection FROM core_github_installations WHERE id = ?",
        recordId,
      );

    await ok("github.installation", { ...base, action: "suspended" }, INTAKE);
    expect((await status()).status).toBe("suspended");
    await ok("github.installation", { ...base, action: "unsuspended" }, INTAKE);
    expect((await status()).status).toBe("active");
    await ok(
      "github.installation",
      { ...base, action: "added", repositorySelection: "all" },
      INTAKE,
    );
    expect(await status()).toEqual({ status: "active", repository_selection: "all" });
    await ok("github.installation", { ...base, action: "deleted" }, INTAKE);
    expect((await status()).status).toBe("deleted");
    // Added again later, it stays deleted until someone connects it again.
    await ok("github.installation", { ...base, action: "added" }, INTAKE);
    expect((await status()).status).toBe("deleted");
  });

  it("records nothing for an installation no org connected, and is for the GitHub intake only", async () => {
    const out = await ok<{ record: string | null }>(
      "github.installation",
      { installationId: numericId(), account: "someone", action: "suspended" },
      INTAKE,
    );
    expect(out.record).toBeNull();
    const p = await person();
    const refused = await refusal(
      call(
        "github.installation",
        { installationId: numericId(), account: "someone", action: "deleted" },
        p.human,
      ),
    );
    expect(refused.code).toBe("forbidden");
  });
});
