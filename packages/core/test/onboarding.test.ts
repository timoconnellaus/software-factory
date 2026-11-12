// Onboarding (ADR 0055): Connect GitHub with a single-use state, the installation verified as the
// App and against the person, kept current by webhooks; the repo picker; the policy syncing itself;
// the template-policy PR; the Setup checklist.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POLICY_PATH } from "../src/index.ts";
import { fakeUserToken, protectedGuards } from "../src/testing/index.ts";
import {
  call,
  first,
  numericId,
  ok,
  POLICY,
  refusal,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

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
  linkedProjects: string[];
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

  it("links an existing project with no installation (the first software-factory) and reads its policy", async () => {
    const p = await person();
    const { installationId, repoId, repoName } = await installOnOwnAccount(p);
    const repo = { installationId, owner: p.login, repo: repoName };
    const head = (await github.getBranchSha(repo, "main")) as string;
    await github.setFile(repo, head, POLICY_PATH, JSON.stringify(POLICY));
    const projectId = `prj_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    const factoryId = `fac_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_factories (id, org_id, name, created_at, created_by) VALUES (?, ?, 'Default', ?, ?)",
      ).bind(factoryId, p.orgId, now, p.userId),
      env.DB.prepare(
        "INSERT INTO core_projects (id, org_id, factory_id, name, slug, created_at, created_by) VALUES (?, ?, ?, 'software-factory', 'software-factory', ?, ?)",
      ).bind(projectId, p.orgId, factoryId, now, p.userId),
      env.DB.prepare(
        "INSERT INTO core_repositories (id, org_id, project_id, owner, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(`repo_${projectId.slice(4)}`, p.orgId, projectId, p.login, repoName, now, p.userId),
    ]);
    const s = await start(p);
    const done = await ok<Connected>(
      "github.connectInstallation",
      { installationId, state: s.state },
      p.human,
    );
    expect(done.linkedProjects).toEqual([projectId]);
    const row = await first<{
      github_installation_id: string;
      installation_record_id: string;
      github_repo_id: number;
      policy_sha: string;
    }>(
      "SELECT r.*, p.policy_sha FROM core_repositories r JOIN core_projects p ON p.id = r.project_id WHERE p.id = ?",
      projectId,
    );
    expect(row).toMatchObject({
      github_installation_id: installationId,
      installation_record_id: done.installation?.id,
      github_repo_id: repoId,
      // The repo's policy, imported as the first config version (ADR 0370).
      policy_sha: "v1",
    });
    const v1 = await first<{ source: string; raw: string }>(
      "SELECT source, raw FROM core_project_policies WHERE project_id = ? AND version = 1",
      projectId,
    );
    expect(v1.source).toBe("import");
    expect(JSON.parse(v1.raw)).toEqual(POLICY);
  });
});

describe("the installation webhooks keep the record current", () => {
  it("removes, suspends, unsuspends and deletes", async () => {
    const w = await world();
    const record = await first<{ id: string; installation_id: string }>(
      "SELECT id, installation_id FROM core_github_installations WHERE org_id = ?",
      w.orgId,
    );
    const base = { installationId: record.installation_id, account: "timoconnellaus" };

    await ok("github.installation", { ...base, action: "suspended", repositories: null }, INTAKE);
    expect(
      (
        await first<{ status: string }>(
          "SELECT status FROM core_github_installations WHERE id = ?",
          record.id,
        )
      ).status,
    ).toBe("suspended");
    const blocked = await refusal(call("policy.resync", { projectId: w.projectId }, w.human));
    expect(blocked.code).toBe("unavailable");
    expect(blocked.message).toMatch(/suspended/);
    const listed = await ok<{ projects: { id: string; connection: { status: string } }[] }>(
      "project.list",
      { orgId: w.orgId },
      w.human,
    );
    expect(listed.projects[0]?.connection.status).toBe("suspended");

    await ok("github.installation", { ...base, action: "unsuspended", repositories: null }, INTAKE);
    const head = (await github.getBranchSha(w.repo, "main")) as string;
    await github.setFile(w.repo, head, POLICY_PATH, JSON.stringify(POLICY));
    await ok("policy.resync", { projectId: w.projectId }, w.human);

    await ok(
      "github.installation",
      { ...base, action: "removed", repositories: [w.repo.repo], repositorySelection: "selected" },
      INTAKE,
    );
    const removed = await first<{
      github_installation_id: string | null;
      installation_record_id: string | null;
    }>(
      "SELECT github_installation_id, installation_record_id FROM core_repositories WHERE project_id = ?",
      w.projectId,
    );
    expect(removed).toEqual({ github_installation_id: null, installation_record_id: null });

    await ok(
      "github.installation",
      { ...base, action: "added", repositories: [w.repo.repo], repositoryIds: [77] },
      INTAKE,
    );
    const back = await first<{ installation_record_id: string; github_repo_id: number }>(
      "SELECT installation_record_id, github_repo_id FROM core_repositories WHERE project_id = ?",
      w.projectId,
    );
    expect(back).toEqual({ installation_record_id: record.id, github_repo_id: 77 });

    await ok("github.installation", { ...base, action: "deleted", repositories: null }, INTAKE);
    expect(
      (
        await first<{ status: string }>(
          "SELECT status FROM core_github_installations WHERE id = ?",
          record.id,
        )
      ).status,
    ).toBe("deleted");
    expect(
      (
        await first<{ id: string | null }>(
          "SELECT github_installation_id AS id FROM core_repositories WHERE project_id = ?",
          w.projectId,
        )
      ).id,
    ).toBeNull();
  });
});

describe("the repo picker", () => {
  it("lists what the org's installations reach, marking repos already used", async () => {
    const w = await world();
    const listed = await ok<{
      repos: { name: string; projectId: string | null; installationRecordId: string }[];
      problems: unknown[];
    }>("github.repos", { orgId: w.orgId }, w.human);
    expect(listed.problems).toEqual([]);
    expect(listed.repos).toEqual([
      expect.objectContaining({ name: w.repo.repo, projectId: w.projectId }),
    ]);
    const outsider = await world();
    const r = await refusal(call("github.repos", { orgId: w.orgId }, outsider.human));
    expect(r.code).toBe("forbidden");
  });

  it("names an installation GitHub couldn't list instead of failing", async () => {
    const w = await world();
    await github.dropInstallation(w.repo.installationId);
    const listed = await ok<{ repos: unknown[]; problems: { account: string }[] }>(
      "github.repos",
      { orgId: w.orgId },
      w.human,
    );
    expect(listed.repos).toEqual([]);
    expect(listed.problems).toEqual([expect.objectContaining({ account: "timoconnellaus" })]);
  });
});

describe("importing the repo's policy (config lives in the app, ADR 0370)", () => {
  it("imports a valid .factory/policy.json from the default branch's head as a new version", async () => {
    const w = await world();
    const head = (await github.getBranchSha(w.repo, "main")) as string;
    await github.setFile(w.repo, head, POLICY_PATH, JSON.stringify({ ...POLICY, wipLimit: 2 }));
    const r = await ok<{ valid: boolean; sha: string }>(
      "policy.resync",
      { projectId: w.projectId },
      w.human,
    );
    expect(r.valid).toBe(true);
    expect(r.sha).toMatch(/^v\d+$/);
    const listed = await ok<{ projects: { policySha: string; policy: { state: string } }[] }>(
      "project.list",
      { orgId: w.orgId },
      w.human,
    );
    expect(listed.projects[0]).toMatchObject({ policySha: r.sha, policy: { state: "valid" } });
  });

  it("refuses an invalid or missing file, and changes nothing", async () => {
    const w = await world();
    const missing = await refusal(call("policy.resync", { projectId: w.projectId }, w.human));
    expect(missing.code).toBe("not_found");
    const head = (await github.getBranchSha(w.repo, "main")) as string;
    await github.setFile(w.repo, head, POLICY_PATH, "{ not json");
    const bad = await refusal(call("policy.resync", { projectId: w.projectId }, w.human));
    expect(bad.code).toBe("invalid_input");
    const row = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      w.projectId,
    );
    expect(row.policy_sha).toBe(w.policySha);
  });
});

describe("setup.status", () => {
  type Status = {
    complete: boolean;
    steps: { key: string; done: boolean; detail: string }[];
    runners: { online: number };
  };
  const step = (s: Status, key: string) => s.steps.find((x) => x.key === key);

  it("starts with Connect GitHub", async () => {
    const p = await person();
    const s = await ok<Status>("setup.status", { orgId: p.orgId }, p.human);
    expect(s.complete).toBe(false);
    expect(s.steps.map((x) => x.done)).toEqual([false, false, false, false, false]);
    expect(step(s, "github")?.detail).toMatch(/Connect GitHub/);
  });

  it("goes green step by step", async () => {
    const w = await world();
    let s = await ok<Status>("setup.status", { orgId: w.orgId }, w.human);
    expect(step(s, "github")?.done).toBe(true);
    expect(step(s, "project")?.done).toBe(true);
    expect(step(s, "policy")?.done).toBe(true);
    expect(step(s, "runner")?.done).toBe(false);
    expect(step(s, "protect")).toMatchObject({ done: false });
    expect(step(s, "protect")?.detail).toMatch(/`factory\/verify` not required/);

    const runner = await ok<{ runnerId: string }>("runner.register", { name: "m5" }, w.human);
    await env.DB.prepare("UPDATE core_runners SET last_seen_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), runner.runnerId)
      .run();
    await github.setGuards(w.repo, protectedGuards());
    s = await ok<Status>("setup.status", { orgId: w.orgId }, w.human);
    expect(s.steps.filter((x) => !x.done)).toEqual([]);
    expect(s.complete).toBe(true);
  });
});
