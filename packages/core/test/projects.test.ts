// project.create takes a repo the org's installation reaches (ADR 0055) and refuses anything else;
// project.update stays as the admin fix from incident 2026-11-11-bootstrap.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { POLICY_PATH } from "../src/index.ts";
import {
  call,
  first,
  numericId,
  ok,
  onboard,
  POLICY,
  refusal,
  services,
  uid,
  world,
} from "./helpers.ts";

const github = services.github;

type View = {
  id: string;
  githubInstallationId: string | null;
  installationWarning?: string | null;
  repo: { owner: string; name: string; defaultBranch: string };
  policySha: string | null;
  connection: { status: string; account: string | null; manageUrl: string | null };
  policy: { state: string; error: string | null; prUrl: string | null };
};

/** A world plus a second repo on the same installation, not yet a project. */
async function withSpareRepo(defaultBranch = "trunk") {
  const w = await world();
  const record = await first<{ id: string; installation_id: string }>(
    "SELECT id, installation_id FROM core_github_installations WHERE org_id = ?",
    w.orgId,
  );
  const repoId = Number(numericId());
  const name = uid("spare-");
  const current = await github.getInstallation(record.installation_id);
  const repos = await github.listInstallationRepos(record.installation_id);
  await github.putInstallation({
    installationId: record.installation_id,
    account: current?.account ?? { login: "timoconnellaus", type: "Organization" },
    repos: [...repos, { id: repoId, owner: "timoconnellaus", name, private: true, defaultBranch }],
    members: [`gh-${w.userId}`],
  });
  return { w, recordId: record.id, installationId: record.installation_id, repoId, name };
}

describe("project.create from the repo picker", () => {
  it("takes the default branch from GitHub and reads the policy right away", async () => {
    const { w, recordId, installationId, repoId, name } = await withSpareRepo("trunk");
    const repo = { installationId, owner: "timoconnellaus", repo: name };
    const head = await github.getBranchSha(repo, "main");
    // The fake's repo starts with `main`; give it the `trunk` GitHub reported, with a policy.
    await github.createBranch(repo, "trunk", head as string);
    await github.setFile(repo, head as string, POLICY_PATH, JSON.stringify(POLICY));
    const p = await ok<View>(
      "project.create",
      { orgId: w.orgId, installationRecordId: recordId, repoId },
      w.human,
    );
    expect(p).toMatchObject({
      repo: { owner: "timoconnellaus", name, defaultBranch: "trunk" },
      // The repo's policy is imported as the first config version (ADR 0370).
      policySha: "v1",
      configVersion: 1,
      githubInstallationId: installationId,
      connection: { status: "connected", account: "timoconnellaus" },
      policy: { state: "valid", error: null },
    });
    expect(p.connection.manageUrl).toBe(
      `https://github.com/organizations/timoconnellaus/settings/installations/${installationId}`,
    );
    const listed = await ok<{ projects: View[] }>("project.list", { orgId: w.orgId }, w.human);
    expect(listed.projects.find((x) => x.id === p.id)).toMatchObject({
      policy: { state: "valid" },
    });
  });

  it("gives a repo with no policy file a template config, with no PR (ADR 0370)", async () => {
    const { w, recordId, repoId } = await withSpareRepo("main");
    const p = await ok<View>(
      "project.create",
      { orgId: w.orgId, installationRecordId: recordId, repoId },
      w.human,
    );
    expect(p).toMatchObject({
      policySha: "v1",
      configVersion: 1,
      policy: { state: "valid", error: null, prUrl: null },
    });
    const v1 = await first<{ raw: string; source: string }>(
      "SELECT raw, source FROM core_project_policies WHERE project_id = ? AND version = 1",
      p.id,
    );
    expect(v1.source).toBe("app");
    expect(JSON.parse(v1.raw)).toMatchObject({
      autonomyPolicy: "balanced",
      approvers: [`gh-${w.userId}`],
    });
    // Work can start straight away.
    await ok(
      "workItem.create",
      { state: "queued", projectId: p.id, title: "x", body: "y" },
      w.human,
    );
  });

  it("refuses a repo the installation can't reach, and saves nothing", async () => {
    const { w, recordId } = await withSpareRepo();
    const before = await first<{ n: number }>(
      "SELECT count(*) AS n FROM core_projects WHERE org_id = ?",
      w.orgId,
    );
    const r = await refusal(
      call(
        "project.create",
        { orgId: w.orgId, installationRecordId: recordId, repoId: 424242 },
        w.human,
      ),
    );
    expect(r.code).toBe("unavailable");
    expect(r.message).toMatch(/can't reach that repository.*Manage repositories on GitHub/);
    const after = await first<{ n: number }>(
      "SELECT count(*) AS n FROM core_projects WHERE org_id = ?",
      w.orgId,
    );
    expect(after.n).toBe(before.n);
  });

  it("refuses another org's installation, a suspended one, free text and a repo already taken", async () => {
    const { w, recordId, repoId } = await withSpareRepo();
    const other = await world();
    const foreign = await refusal(
      call(
        "project.create",
        { orgId: other.orgId, installationRecordId: recordId, repoId },
        other.human,
      ),
    );
    expect(foreign.code).toBe("not_found");

    const text = await refusal(
      call(
        "project.create",
        { orgId: w.orgId, name: "x", repoOwner: "timoconnellaus", repoName: "y" },
        w.human,
      ),
    );
    expect(text.code).toBe("invalid_input");

    await ok("project.create", { orgId: w.orgId, installationRecordId: recordId, repoId }, w.human);
    const twice = await refusal(
      call("project.create", { orgId: w.orgId, installationRecordId: recordId, repoId }, w.human),
    );
    expect(twice.code).toBe("conflict");

    await env.DB.prepare("UPDATE core_github_installations SET status = 'suspended' WHERE id = ?")
      .bind(recordId)
      .run();
    const suspended = await refusal(
      call("project.create", { orgId: w.orgId, installationRecordId: recordId, repoId }, w.human),
    );
    expect(suspended.code).toBe("unavailable");
    expect(suspended.message).toMatch(/suspended/);
  });

  it("is for org owners and admins", async () => {
    const { w, recordId, repoId } = await withSpareRepo();
    const outsider = await world();
    const r = await refusal(
      call(
        "project.create",
        { orgId: w.orgId, installationRecordId: recordId, repoId },
        outsider.human,
      ),
    );
    expect(r.code).toBe("forbidden");
  });
});

describe("project.update (admin fix, not in onboarding)", () => {
  it("sets the installation by detection, audited", async () => {
    const w = await world();
    await env.DB.prepare(
      "UPDATE core_repositories SET github_installation_id = NULL, installation_record_id = NULL WHERE project_id = ?",
    )
      .bind(w.projectId)
      .run();
    await github.setInstallation({ owner: "timoconnellaus", repo: w.repo.repo }, null);
    const miss = await refusal(
      ok("project.update", { projectId: w.projectId, detectInstallation: true }, w.human),
    );
    expect(miss.code).toBe("not_found");
    expect(miss.message).toMatch(/isn't installed on/);

    await github.setInstallation({ owner: "timoconnellaus", repo: w.repo.repo }, "778");
    const fixed = await ok<View>(
      "project.update",
      { projectId: w.projectId, detectInstallation: true },
      w.human,
    );
    expect(fixed).toMatchObject({ githubInstallationId: "778", installationWarning: null });
    const audit = await first<{ diff: string }>(
      "SELECT diff FROM core_audit WHERE operation = 'project.update' AND project_id = ? ORDER BY at DESC LIMIT 1",
      w.projectId,
    );
    expect(JSON.parse(audit.diff)).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ githubInstallationId: null }),
        after: expect.objectContaining({ githubInstallationId: "778" }),
      }),
    ]);
  });

  it("sets an id by hand, and a new default branch keeps the config (ADR 0370)", async () => {
    const w = await world();
    const set = await ok<View>(
      "project.update",
      { projectId: w.projectId, githubInstallationId: "99", defaultBranch: "trunk" },
      w.human,
    );
    expect(set).toMatchObject({
      githubInstallationId: "99",
      repo: { defaultBranch: "trunk" },
      policySha: w.policySha,
      policy: { state: "valid" },
    });
  });

  it("is for org owners and admins only, and people only", async () => {
    const w = await world();
    const other = await world();
    const r = await refusal(
      call("project.update", { projectId: w.projectId, githubInstallationId: "1" }, other.human),
    );
    expect(r.code).toBe("forbidden");
    const agent = await refusal(
      call(
        "project.update",
        { projectId: w.projectId, githubInstallationId: "1" },
        { type: "agent", id: "foreman" },
      ),
    );
    expect(["forbidden", "denied"]).toContain(agent.code);
    const empty = await refusal(call("project.update", { projectId: w.projectId }, w.human));
    expect(empty.code).toBe("invalid_input");
  });
});

describe("the onboard helper", () => {
  it("is what Setup does", async () => {
    const w = await world();
    const human = w.human;
    const repo = await onboard(human, w.orgId, { owner: "timoconnellaus", name: uid("r-") });
    expect(repo.installationRecordId).toMatch(/^ghi_/);
  });
});
