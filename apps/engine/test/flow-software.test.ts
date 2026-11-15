// Software work on the new core (spec 70, the software plugin) through the engine's real routes: a
// project with a GitHub repository, a run on it that works on the item's branch (claim, token,
// hand-back), the built-in `github` gateway, and plugins/software/plugin.js walked end to end. The
// App is the fake (GITHUB_FAKE=1, packages/core/testing); the REST API the gateway calls is faked
// over fetch, as flow-plugins.test.ts fakes a gateway's upstream.
import { env } from "cloudflare:workers";
import { PLUGIN_GUIDE } from "@software-factory/plugins";
import { ChannelCallError, jobSchema } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import SOFTWARE_PLUGIN from "../../../plugins/software/plugin.js?raw";
import { claim, type Person, person, post } from "./flow-helpers.ts";
import { first, github, uid } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

type Item = {
  id: string;
  statusId: string;
  error: string | null;
  fields: Record<string, unknown>;
  branch: string | null;
  headSha: string | null;
};
type Entry = { kind: string; actor: { kind: string; id?: string }; data: Record<string, unknown> };

const sha = (c: string) => c.repeat(40);

let installations = 0;

/** Connects the person's org to GitHub, as the connect flow leaves it: one repository. */
async function connect(p: Person) {
  const installationId = `9${Date.now()}${installations++}`;
  const name = uid("app-").toLowerCase();
  await github.putInstallation({
    installationId,
    account: { login: "acme", type: "Organization" },
    repos: [{ id: Date.now(), owner: "acme", name, private: true, defaultBranch: "main" }],
  });
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_github_installations (id, org_id, installation_id, account_login, account_type,
      repository_selection, status, connected_by, created_at, updated_at)
     VALUES (?, ?, ?, 'acme', 'Organization', 'selected', 'active', ?, ?, ?)`,
  )
    .bind(uid("ghi_"), p.orgId, installationId, p.userId, now, now)
    .run();
  return {
    installationId,
    owner: "acme",
    name,
    ref: { installationId, owner: "acme", repo: name },
  };
}

/** Build (an agent) → Review (the person) → Merged (nobody), a project keyed APP, and an item. */
async function software(p: Person) {
  const agent = await p.call<{ id: string }>("flow.agent.create", {
    name: "Builder",
    instructions: "You write code.",
  });
  const workflow = await p.call<{ id: string }>("flow.workflow.create", {
    name: "Software",
    statuses: [
      {
        id: "build",
        name: "Build",
        owner: { kind: "agent", agentId: agent.id },
        brief: "Build it.",
      },
      { id: "review", name: "Code review", owner: { kind: "person", userId: p.userId } },
      { id: "merged", name: "Merged", owner: { kind: "none" } },
    ],
  });
  const project = await p.call<{ id: string }>("flow.project.create", {
    name: "App",
    key: "APP",
    workflowId: workflow.id,
  });
  return { agent, workflow, project };
}

const newItem = (p: Person, projectId: string, title = "Add a login page") =>
  p.call<Item>("flow.item.create", { projectId, title, body: "With a form." });

async function refused(p: Person, op: string, input: Record<string, unknown>) {
  const res = await post("call", { op, input: { orgId: p.orgId, ...input } }, p.token);
  return { status: res.status, body: (await res.json()) as { code: string; error: string } };
}

/** The runner hands the job back done, having pushed `head` to the item's branch. */
async function handBack(
  p: Person,
  job: { jobId: string; lease: { fencingToken: number } },
  branch: string,
  head: string,
) {
  await p.channel.handback({
    jobId: job.jobId,
    fencingToken: job.lease.fencingToken,
    outcome: "completed",
    artifactIds: [],
    branch,
    headSha: head,
    result: { outcome: "done", summary: "Added the login page." },
  });
  await p.channel.release({
    jobId: job.jobId,
    fencingToken: job.lease.fencingToken,
    finalState: "handed_back",
  });
}

describe("a project with a repository", () => {
  it("lists the org's repositories, sets one on a project, and refuses one it can't reach", async () => {
    const p = await person();
    const { project } = await software(p);
    expect(await p.call("flow.github.repos", {})).toEqual({
      connected: false,
      account: null,
      repos: [],
    });
    const notYet = await refused(p, "flow.project.setRepository", {
      projectId: project.id,
      owner: "acme",
      name: "x",
    });
    expect(notYet.status).toBe(409);

    const gh = await connect(p);
    const listed = await p.call<{ connected: boolean; repos: unknown[] }>("flow.github.repos", {});
    expect(listed).toEqual({
      connected: true,
      account: "acme",
      repos: [
        { owner: "acme", name: gh.name, defaultBranch: "main", installationId: gh.installationId },
      ],
    });
    const unreachable = await refused(p, "flow.project.setRepository", {
      projectId: project.id,
      owner: "acme",
      name: "elsewhere",
    });
    expect(unreachable.status).toBe(404);
    const set = await p.call<{ repo: unknown }>("flow.project.setRepository", {
      projectId: project.id,
      owner: "ACME",
      name: gh.name.toUpperCase(),
    });
    const repo = {
      owner: "acme",
      name: gh.name,
      defaultBranch: "main",
      installationId: gh.installationId,
    };
    expect(set.repo).toEqual(repo);
    expect(
      (await p.call<{ repo: unknown }>("flow.project.get", { projectId: project.id })).repo,
    ).toEqual(repo);
    const list = await p.call<{ projects: { repo: unknown }[] }>("flow.project.list", {});
    expect(list.projects[0]?.repo).toEqual(repo);
    const cleared = await p.call<{ repo: unknown }>("flow.project.setRepository", {
      projectId: project.id,
      clear: true,
    });
    expect(cleared.repo).toBeNull();
  });

  it("claims a run with the repository and the item's branch, mints its token, and keeps its head", async () => {
    const p = await person();
    const gh = await connect(p);
    const { project } = await software(p);
    await p.call("flow.project.setRepository", {
      projectId: project.id,
      owner: "acme",
      name: gh.name,
    });
    const item = await newItem(p, project.id);

    const job = await claim(p);
    if (!job) throw new Error("no job");
    expect(jobSchema.safeParse(job).success).toBe(true);
    const branch = "factory/flow-app-1";
    expect(job).toMatchObject({
      stage: "flow",
      repo: {
        url: `https://github.com/acme/${gh.name}.git`,
        owner: "acme",
        name: gh.name,
        baseRef: "main",
        defaultBranch: "main",
      },
      branch,
    });
    expect(job.harness.prompt).toContain(
      `You are in a checkout of acme/${gh.name} on branch \`${branch}\``,
    );
    expect(job.harness.prompt).toContain("Do not push");
    expect((await p.call<Item>("flow.item.get", { itemId: item.id })).branch).toBe(branch);

    // The token: one repository, this run's branch; a stale fencing token gets none.
    const minted = (await github.state(gh.ref)).tokens;
    const token = await p.channel.token(job.jobId, job.lease.fencingToken);
    expect(token).toMatchObject({ repo: { owner: "acme", name: gh.name }, pushBranch: branch });
    expect(token.token).toMatch(/^ghs_fake_/);
    expect((await github.state(gh.ref)).tokens).toBe(minted + 1);
    const stale = await p.channel.token(job.jobId, job.lease.fencingToken - 1).catch((e) => e);
    expect(stale).toBeInstanceOf(ChannelCallError);
    expect((stale as ChannelCallError).status).toBe(409);
    expect((await github.state(gh.ref)).tokens).toBe(minted + 1);

    // The hand-back's branch and head are kept on the run and the item.
    await handBack(p, job, branch, sha("a"));
    expect(await first("SELECT branch, head_sha FROM flow_runs WHERE id = ?", job.jobId)).toEqual({
      branch,
      head_sha: sha("a"),
    });
    const after = await p.call<Item>("flow.item.get", { itemId: item.id });
    expect(after).toMatchObject({ statusId: "review", branch, headSha: sha("a") });

    // Back to Build: the next run continues on the item's branch.
    await p.call("flow.item.move", { itemId: item.id, to: "build" });
    const again = await claim(p);
    expect(again).toMatchObject({ branch, repo: { baseRef: branch, defaultBranch: "main" } });
  });

  it("asks GitHub for the branch only when an earlier run on it left no head", async () => {
    const p = await person();
    const gh = await connect(p);
    const { project } = await software(p);
    await p.call("flow.project.setRepository", {
      projectId: project.id,
      owner: "acme",
      name: gh.name,
    });
    const item = await newItem(p, project.id);
    const job = await claim(p);
    if (!job) throw new Error("no job");
    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "failed",
      artifactIds: [],
      branch: "factory/flow-app-1",
      summary: "The tests wouldn't run.",
    });
    // It pushed before it failed: the branch is on GitHub though the item has no head.
    await github.push(gh.ref, "factory/flow-app-1");
    await p.call("flow.item.retry", { itemId: item.id });
    expect(await claim(p)).toMatchObject({ repo: { baseRef: "factory/flow-app-1" } });
  });

  it("gives a run on a project without a repository no repo, branch or token", async () => {
    const p = await person();
    await connect(p);
    const { project } = await software(p);
    await newItem(p, project.id);
    const job = await claim(p);
    if (!job) throw new Error("no job");
    expect(job.repo).toBeUndefined();
    expect(job.branch).toBeUndefined();
    const token = await p.channel.token(job.jobId, job.lease.fencingToken).catch((e) => e);
    expect((token as ChannelCallError).status).toBe(404);
  });
});

describe("the built-in github gateway", () => {
  it("is listed read-only, can't be saved over, and calls the item's repository with a minted token", async () => {
    const p = await person();
    expect(
      (await p.call<{ gateways: { name: string }[] }>("flow.gateway.list", {})).gateways,
    ).toEqual([]);
    const gh = await connect(p);
    const { gateways } = await p.call<{ gateways: Record<string, unknown>[] }>(
      "flow.gateway.list",
      {},
    );
    expect(gateways).toEqual([
      expect.objectContaining({
        name: "github",
        builtIn: true,
        description: "GitHub, connected as acme",
      }),
    ]);
    const save = await refused(p, "flow.gateway.save", {
      name: "github",
      baseUrl: "https://example.com",
      auth: { kind: "none" },
    });
    expect(save.status).toBe(409);
    // Nor can another gateway be renamed to it, or it be deleted.
    const blog = await p.call<{ id: string }>("flow.gateway.save", {
      name: "blog",
      baseUrl: "https://blog.example",
      auth: { kind: "none" },
    });
    const rename = await refused(p, "flow.gateway.save", {
      gatewayId: blog.id,
      name: "github",
      baseUrl: "https://blog.example",
      auth: { kind: "none" },
    });
    expect(rename.status).toBe(409);
    expect((await refused(p, "flow.gateway.delete", { name: "github" })).status).toBe(409);
    await p.call("flow.gateway.delete", { gatewayId: blog.id });

    const { project, workflow } = await software(p);
    const other = await p.call<{ id: string }>("flow.project.create", {
      name: "Notes",
      key: "NTS",
      workflowId: workflow.id,
    });
    await p.call("flow.project.setRepository", {
      projectId: project.id,
      owner: "acme",
      name: gh.name,
    });
    const seen: { url: string; auth: string | null }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, auth: request.headers.get("authorization") });
      return Response.json({ default_branch: "main" });
    });
    await p.call("flow.plugin.save", {
      name: "peek",
      request: "Peek at the repository.",
      code: `export default { on: { async entered(ctx, { item, to }) {
        if (to !== "review") return;
        const said = await ctx.gateway("github").fetch("/branches/main").then(
          async (r) => "ok " + r.status + " " + (await r.json()).default_branch,
          (e) => e.message,
        );
        await ctx.comment(said + " repo=" + JSON.stringify(item.repo));
      } } };`,
    });
    const withRepo = await newItem(p, project.id);
    const without = await newItem(p, other.id, "Write notes");
    await p.call("flow.item.move", { itemId: withRepo.id, to: "review" });
    await p.call("flow.item.move", { itemId: without.id, to: "review" });
    const comment = async (itemId: string) =>
      (await p.call<{ entries: Entry[] }>("flow.timeline.get", { itemId })).entries
        .filter((e) => e.kind === "comment")
        .map((e) => String(e.data.text));
    expect(await comment(withRepo.id)).toEqual([
      `ok 200 main repo=${JSON.stringify({ owner: "acme", name: gh.name, defaultBranch: "main" })}`,
    ]);
    expect(await comment(without.id)).toEqual([
      "This item's project has no repository (set one in its Settings). repo=null",
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://api.github.com/repos/acme/${gh.name}/branches/main`);
    expect(seen[0]?.auth).toMatch(/^Bearer ghs_fake_/);
  });
});

/** A small GitHub REST API for one repository: pulls, their checks, and merging. */
function fakeRest(owner: string, name: string) {
  const root = `https://api.github.com/repos/${owner}/${name}`;
  const pulls: {
    number: number;
    title: string;
    body: string;
    head: string;
    base: string;
    sha: string;
    state: "open" | "closed";
    merged: boolean;
  }[] = [];
  const checks = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
  const calls: string[] = [];
  let refuseMerge: string | null = null;
  const view = (pr: (typeof pulls)[number]) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: pr.merged,
    additions: 12,
    deletions: 3,
    html_url: `https://github.com/${owner}/${name}/pull/${pr.number}`,
    head: { ref: pr.head, sha: pr.sha },
    base: { ref: pr.base },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!request.url.startsWith(root)) return new Response("not found", { status: 404 });
    if (!request.headers.get("authorization")?.startsWith("Bearer ghs_fake_")) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const path = url.pathname.slice(new URL(root).pathname.length);
    calls.push(`${request.method} ${path}`);
    if (request.method === "GET" && path === "/pulls") {
      const head = url.searchParams.get("head")?.split(":")[1];
      return Response.json(pulls.filter((p) => p.state === "open" && p.head === head).map(view));
    }
    if (request.method === "POST" && path === "/pulls") {
      const body = (await request.json()) as {
        title: string;
        head: string;
        base: string;
        body: string;
      };
      const pr = {
        number: pulls.length + 7,
        ...body,
        sha: state.heads.get(body.head) ?? "",
        state: "open" as const,
        merged: false,
      };
      pulls.push(pr);
      return Response.json(view(pr), { status: 201 });
    }
    const one = path.match(/^\/pulls\/(\d+)(\/merge)?$/);
    if (one) {
      const pr = pulls.find((p) => p.number === Number(one[1]));
      if (!pr) return Response.json({ message: "Not Found" }, { status: 404 });
      if (!one[2]) return Response.json(view(pr));
      if (refuseMerge) return Response.json({ message: refuseMerge }, { status: 405 });
      pr.state = "closed";
      pr.merged = true;
      return Response.json({ merged: true, sha: sha("m") });
    }
    const checked = path.match(/^\/commits\/([0-9a-f]{40})\/check-runs$/);
    if (checked?.[1]) {
      const runs = checks.get(checked[1]) ?? [];
      return Response.json({ total_count: runs.length, check_runs: runs });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  const state = {
    pulls,
    calls,
    heads: new Map<string, string>(),
    setChecks: (
      head: string,
      runs: { name: string; status: string; conclusion: string | null }[],
    ) => checks.set(head, runs),
    refuseMerge: (message: string | null) => {
      refuseMerge = message;
    },
  };
  return state;
}

describe("the software plugin (plugins/software/plugin.js)", () => {
  it("opens a pull request when a run pushes, holds Review until checks pass, and merges on Merged", async () => {
    const p = await person();
    const gh = await connect(p);
    const { project } = await software(p);
    await p.call("flow.project.setRepository", {
      projectId: project.id,
      owner: "acme",
      name: gh.name,
    });
    const saved = await p.call<{ hooks: string[] }>("flow.plugin.save", {
      name: "software",
      request: "Pull requests for software projects.",
      code: SOFTWARE_PLUGIN,
    });
    expect(saved.hooks.sort()).toEqual(["entered", "leaving", "runEnded"]);
    // plugin_guide quotes this exact file as its example.
    expect(PLUGIN_GUIDE).toContain(SOFTWARE_PLUGIN.trim());
    const rest = fakeRest("acme", gh.name);
    const item = await newItem(p, project.id);
    const branch = "factory/flow-app-1";
    const head = sha("b");
    rest.heads.set(branch, head);
    rest.setChecks(head, [
      { name: "ci", status: "in_progress", conclusion: null },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);

    // The run ends with a head: a pull request from the item's branch, its number, and a card.
    const job = await claim(p);
    if (!job) throw new Error("no job");
    await handBack(p, job, branch, head);
    const reviewed = await p.call<Item>("flow.item.get", { itemId: item.id });
    expect(reviewed).toMatchObject({ statusId: "review", error: null, fields: { pr: 7 } });
    expect(rest.pulls).toEqual([
      expect.objectContaining({
        number: 7,
        title: "Add a login page",
        head: branch,
        base: "main",
        body: "Added the login page.\n\nFor item #1: Add a login page",
      }),
    ]);
    const cards = (
      await p.call<{ entries: Entry[] }>("flow.timeline.get", { itemId: item.id })
    ).entries.filter((e) => e.kind === "card");
    expect(cards.map((c) => c.data)).toEqual([
      {
        kind: "pull-request",
        title: "#7 Add a login page",
        subtitle: "+12 −3",
        checks: [
          { label: "ci (running)", ok: false },
          { label: "lint", ok: true },
        ],
        link: { label: "Open on GitHub", url: `https://github.com/acme/${gh.name}/pull/7` },
      },
    ]);

    // Leaving review is refused while a check runs, and allowed once it passes.
    const held = await refused(p, "flow.item.move", { itemId: item.id, to: "merged" });
    expect(held.status).toBe(409);
    expect(held.body.error).toContain("still running: ci");
    rest.setChecks(head, [
      { name: "ci", status: "completed", conclusion: "failure" },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    expect(
      (await refused(p, "flow.item.move", { itemId: item.id, to: "merged" })).body.error,
    ).toContain("failed: ci");
    rest.setChecks(head, [
      { name: "ci", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);

    // GitHub refuses the merge: the item stops with its message, and a retry merges.
    rest.refuseMerge("Base branch was modified. Review and try the merge again.");
    const stopped = await p.call<Item>("flow.item.move", { itemId: item.id, to: "merged" });
    expect(stopped.statusId).toBe("merged");
    expect(stopped.error).toContain("Base branch was modified");
    rest.refuseMerge(null);
    const merged = await p.call<Item>("flow.item.retry", { itemId: item.id });
    expect(merged).toMatchObject({ statusId: "merged", error: null });
    expect(rest.pulls[0]).toMatchObject({ state: "closed", merged: true });
    expect(rest.calls.filter((c) => c.startsWith("PUT"))).toEqual([
      "PUT /pulls/7/merge",
      "PUT /pulls/7/merge",
    ]);
    const last = (
      await p.call<{ entries: Entry[] }>("flow.timeline.get", { itemId: item.id })
    ).entries
      .filter((e) => e.kind === "card")
      .at(-1);
    expect(last?.data).toMatchObject({
      title: "Merged #7 Add a login page",
      subtitle: "into main",
    });
  });
});
