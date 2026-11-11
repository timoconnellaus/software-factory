// Incident 2026-11-11-bootstrap: project.create saved software-factory with no GitHub App
// installation, silently, and nothing could fix it afterwards.
import { describe, expect, it } from "vitest";
import { call, first, ok, refusal, services, uid, world } from "./helpers.ts";

const github = services.github;

type View = {
  id: string;
  githubInstallationId: string | null;
  installationWarning: string | null;
  repo: { defaultBranch: string };
  policySha: string | null;
};

async function create(w: Awaited<ReturnType<typeof world>>, repoName: string) {
  return ok<View>(
    "project.create",
    { orgId: w.orgId, name: uid("p-"), repoOwner: "timoconnellaus", repoName },
    w.human,
  );
}

describe("project.create finds the App's installation", () => {
  it("as the App, when no id is given", async () => {
    const w = await world();
    const repoName = uid("repo-");
    await github.setInstallation({ owner: "timoconnellaus", repo: repoName }, "777");
    const p = await create(w, repoName);
    expect(p).toMatchObject({ githubInstallationId: "777", installationWarning: null });
  });

  it("saves the project but says why when there is none", async () => {
    const w = await world();
    const repoName = uid("repo-");
    await github.setInstallation({ owner: "timoconnellaus", repo: repoName }, null);
    const p = await create(w, repoName);
    expect(p.githubInstallationId).toBeNull();
    expect(p.installationWarning).toMatch(
      new RegExp(`No GitHub App installation: .*isn't installed on timoconnellaus/${repoName}`),
    );
  });
});

describe("project.update", () => {
  it("sets the installation by detection, audited, before any policy is synced", async () => {
    const w = await world();
    const repoName = uid("repo-");
    await github.setInstallation({ owner: "timoconnellaus", repo: repoName }, null);
    const p = await create(w, repoName);
    expect(p.policySha).toBeNull();

    const miss = await refusal(
      ok("project.update", { projectId: p.id, detectInstallation: true }, w.human),
    );
    expect(miss.code).toBe("not_found");
    expect(miss.message).toMatch(/isn't installed on/);

    await github.setInstallation({ owner: "timoconnellaus", repo: repoName }, "778");
    const fixed = await ok<View>(
      "project.update",
      { projectId: p.id, detectInstallation: true },
      w.human,
    );
    expect(fixed).toMatchObject({ githubInstallationId: "778", installationWarning: null });
    const audit = await first<{ diff: string }>(
      "SELECT diff FROM core_audit WHERE operation = 'project.update' AND project_id = ? ORDER BY at DESC LIMIT 1",
      p.id,
    );
    expect(JSON.parse(audit.diff)).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ githubInstallationId: null }),
        after: expect.objectContaining({ githubInstallationId: "778" }),
      }),
    ]);
  });

  it("sets an id by hand, and a new default branch clears the synced policy", async () => {
    const w = await world();
    const set = await ok<View>(
      "project.update",
      { projectId: w.projectId, githubInstallationId: "99", defaultBranch: "trunk" },
      w.human,
    );
    expect(set).toMatchObject({
      githubInstallationId: "99",
      repo: { defaultBranch: "trunk" },
      policySha: null,
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
