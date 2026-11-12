// A project is not a repository (spec 50 part A, ADR 0490): zero or more repositories per project,
// an item uses one, and an operation that needs one refuses rather than guessing between two.
import { describe, expect, it } from "vitest";
import {
  call,
  first,
  newItem,
  numericId,
  ok,
  refusal,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

const github = services.github;

type Repo = { id: string; projectId: string; owner: string; name: string; defaultBranch: string };
type Project = {
  id: string;
  repo: { owner: string; name: string; defaultBranch: string } | null;
  repositories: Repo[];
  policy: { state: string };
  configVersion: number | null;
};

/** A world plus a second repo the org's installation reaches, not yet in any project. */
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
  return { w, recordId: record.id, repoId, name };
}

describe("projects and repositories (ADR 0490)", () => {
  it("gives a project created from the repo picker one repository, and the item that repository", async () => {
    const w = await world();
    const [project] = (
      await ok<{ projects: Project[] }>("project.list", { orgId: w.orgId }, w.human)
    ).projects;
    expect(project?.repositories).toHaveLength(1);
    expect(project?.repo).toEqual({
      owner: "timoconnellaus",
      name: w.repo.repo,
      defaultBranch: "main",
    });
    const item = await newItem(w);
    const row = await first<{ repository_id: string }>(
      "SELECT repository_id FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row.repository_id).toBe(project?.repositories[0]?.id);
  });

  it("creates a project with no repository, on the template config", async () => {
    const w = await world();
    const p = await ok<Project>("project.create", { orgId: w.orgId, name: "Marketing" }, w.human);
    expect(p.repo).toBeNull();
    expect(p.repositories).toEqual([]);
    expect(p.policy.state).toBe("valid");
    expect(p.configVersion).toBe(1);
    // Work on it that needs code is refused with the reason (part B lets it wait in the backlog).
    // It can be captured, but not released while its workflow needs a repository (ADR 0491).
    const captured = await ok<{ workItemId: string; status: string }>(
      "workItem.create",
      { projectId: p.id, title: "Launch post" },
      w.human,
    );
    expect(captured.status).toBe("backlog");
    const e = await refusal(call("workItem.release", { workItemId: captured.workItemId }, w.human));
    expect(e.code).toBe("conflict");
    expect(e.message).toMatch(/its project has none/);
    // Nothing to import config from.
    const imported = await refusal(call("policy.resync", { projectId: p.id }, w.human));
    expect(imported.message).toMatch(/has no repository/);
  });

  it("refuses a project with no repository and no name, and half a repository", async () => {
    const w = await world();
    expect((await refusal(call("project.create", { orgId: w.orgId }, w.human))).code).toBe(
      "invalid_input",
    );
    expect(
      (await refusal(call("project.create", { orgId: w.orgId, repoId: 5, name: "x" }, w.human)))
        .code,
    ).toBe("invalid_input");
  });

  it("adds a second repository; a call that needs one must then name it", async () => {
    const { w, recordId, repoId, name } = await withSpareRepo("trunk");
    const added = await ok<Repo>(
      "repository.add",
      { projectId: w.projectId, installationRecordId: recordId, repoId },
      w.human,
    );
    expect(added).toMatchObject({ projectId: w.projectId, name, defaultBranch: "trunk" });
    const listed = await ok<{ repositories: Repo[] }>(
      "repository.list",
      { orgId: w.orgId, projectId: w.projectId },
      w.human,
    );
    expect(listed.repositories.map((r) => r.name)).toEqual([w.repo.repo, name]);

    // Two repositories and none named: release is refused with the reason, never a guess.
    const e = await refusal(
      call("workItem.create", { projectId: w.projectId, title: "x", state: "queued" }, w.human),
    );
    expect(e.code).toBe("conflict");
    expect(e.message).toMatch(/choose one of the project's 2/);

    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, repositoryId: added.id, title: "Fix the site", state: "queued" },
      w.human,
    );
    const row = await first<{ repository_id: string }>(
      "SELECT repository_id FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row.repository_id).toBe(added.id);

    // The same GitHub repository can't be in two projects.
    const again = await refusal(
      call(
        "repository.add",
        { projectId: w.projectId, installationRecordId: recordId, repoId },
        w.human,
      ),
    );
    expect(again.code).toBe("conflict");

    // A repository of another project is not this project's.
    const other = await world();
    const foreign = await refusal(
      call(
        "workItem.create",
        { projectId: w.projectId, repositoryId: (await repoOf(other.projectId)).id, title: "x" },
        w.human,
      ),
    );
    expect(foreign.code).toBe("not_found");
  });

  it("fixes one repository's connection with repository.update; project.update needs a name with two", async () => {
    const { w, recordId, repoId } = await withSpareRepo();
    const added = await ok<Repo>(
      "repository.add",
      { projectId: w.projectId, installationRecordId: recordId, repoId },
      w.human,
    );
    const fixed = await ok<Repo & { installationWarning: string | null }>(
      "repository.update",
      { repositoryId: added.id, defaultBranch: "develop" },
      w.human,
    );
    expect(fixed.defaultBranch).toBe("develop");
    const e = await refusal(
      call("project.update", { projectId: w.projectId, defaultBranch: "x" }, w.human),
    );
    expect(e.message).toMatch(/several repositories/);
    await ok(
      "project.update",
      { projectId: w.projectId, repositoryId: added.id, defaultBranch: "main" },
      w.human,
    );
    const after = await rows<{ id: string; default_branch: string }>(
      "SELECT id, default_branch FROM core_repositories WHERE project_id = ? ORDER BY created_at, id",
      w.projectId,
    );
    expect(after.find((r) => r.id === added.id)?.default_branch).toBe("main");
  });

  it("finds the project from a repository for webhook calls", async () => {
    const w = await world();
    const out = await ok<{ previous: unknown; state: string }>(
      "protection.observe",
      { repo: { owner: "timoconnellaus", name: w.repo.repo }, event: "daily", action: "recheck" },
      { type: "intake", id: "github" },
    );
    expect(["ok", "red", "unknown"]).toContain(out.state);
  });
});

async function repoOf(projectId: string) {
  return first<{ id: string }>("SELECT id FROM core_repositories WHERE project_id = ?", projectId);
}
