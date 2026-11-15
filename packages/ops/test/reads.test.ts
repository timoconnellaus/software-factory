// The desktop app's reads: members, the inbox across orgs, items with their project and status
// names, open counts, runs by agent and by id, what each agent works on, and a summary's run.
import { env } from "cloudflare:workers";
import { finishRun } from "@software-factory/store";
import { describe, expect, it } from "vitest";
import { type Caller, type CallResult, call } from "../src/index.ts";

const d1 = env.DB;
const now = () => new Date().toISOString();

/** A person in core_user, with a GitHub login or none. */
async function person(name: string, login: string | null = null) {
  const id = `usr_${crypto.randomUUID()}`;
  await d1
    .prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, name, `${id}@example.com`, login, now(), now())
    .run();
  return id;
}

/** An org named `name` with these people as members. */
async function org(name: string, members: string[]) {
  const orgId = `org_${crypto.randomUUID()}`;
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, ?, ?, 'team', ?)",
      )
      .bind(orgId, name, orgId, now()),
    ...members.map((userId) =>
      d1
        .prepare(
          "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
        )
        .bind(`mem_${crypto.randomUUID()}`, orgId, userId, now()),
    ),
  ]);
  return orgId;
}

function ok<T = Record<string, unknown>>(r: CallResult): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

const as = (userId: string) => (op: string, input: Record<string, unknown>) =>
  call(op, input, { d1, actor: { kind: "person", id: userId } });

/**
 * In `orgId`, as `userId`: an agent, Draft (the agent) → Review (userId) → Approve (nobody, needs a
 * decision) → Done, a project "key" on it, and items in it.
 */
async function world(orgId: string, userId: string, key: string) {
  const op = (name: string, input: Record<string, unknown>) =>
    as(userId)(name, { orgId, ...input });
  const agent = ok<{ id: string }>(
    await op("flow.agent.create", { name: `Writer ${key}`, instructions: "" }),
  );
  const workflow = ok<{ id: string }>(
    await op("flow.workflow.create", {
      name: "Flow",
      statuses: [
        { id: "draft", name: "Draft", owner: { kind: "agent", agentId: agent.id } },
        { id: "review", name: "Review", owner: { kind: "person", userId } },
        { id: "approve", name: "Approve", owner: { kind: "none" }, needsDecision: true },
        { id: "done", name: "Done", owner: { kind: "none" } },
      ],
    }),
  );
  const project = ok<{ id: string }>(
    await op("flow.project.create", { name: `Project ${key}`, key, workflowId: workflow.id }),
  );
  const item = async (title: string, to?: string) => {
    const created = ok<{ id: string }>(
      await op("flow.item.create", { projectId: project.id, title }),
    );
    if (to) ok(await op("flow.item.move", { itemId: created.id, to }));
    return created.id;
  };
  return { op, agent, workflow, project, item };
}

type Listed = {
  id: string;
  orgId: string;
  projectId: string;
  projectName: string;
  projectKey: string;
  statusName: string;
};
type OrgInbox = {
  orgId: string;
  name: string;
  work: Listed[];
  decisions: Listed[];
  working: Listed[];
};

describe("the desktop app's reads", () => {
  it("flow.member.list: the org's members with their logins, and no one else's", async () => {
    const sam = await person("Sam", `sam-${crypto.randomUUID()}`);
    const pat = await person("Pat");
    const lee = await person("Lee");
    const a = await org("A", [sam, pat]);
    const b = await org("B", [lee]);
    const { members } = ok<{ members: unknown[] }>(await as(sam)("flow.member.list", { orgId: a }));
    expect(members).toEqual([
      { userId: pat, name: "Pat", login: null },
      { userId: sam, name: "Sam", login: expect.stringMatching(/^sam-/) },
    ]);
    expect(await as(sam)("flow.member.list", { orgId: b })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("flow.inbox.all: what waits on you in each of your orgs, and nothing of another org", async () => {
    const sam = await person("Sam");
    const lee = await person("Lee");
    const a = await org("Alpha", [sam]);
    const b = await org("Beta", [sam, lee]);
    const c = await org("Gamma", [lee]);
    const wa = await world(a, sam, "ALP");
    const working = await wa.item("Being drafted");
    const review = await wa.item("To review", "review");
    const decide = await wa.item("To approve", "approve");
    const wb = await world(b, sam, "BET");
    const leeWork = await world(c, lee, "GAM");
    await leeWork.item("Lee's review", "review");
    const forSam = await wb.item("Beta review", "review");

    const { orgs } = ok<{ orgs: OrgInbox[] }>(await as(sam)("flow.inbox.all", {}));
    expect(orgs.map((o) => [o.orgId, o.name])).toEqual([
      [a, "Alpha"],
      [b, "Beta"],
    ]);
    const alpha = orgs[0] as OrgInbox;
    expect(alpha.work.map((i) => i.id)).toEqual([review]);
    expect(alpha.decisions.map((i) => i.id)).toEqual([decide]);
    expect(alpha.working.map((i) => i.id)).toEqual([working]);
    expect(alpha.work[0]).toMatchObject({
      orgId: a,
      projectId: wa.project.id,
      projectName: "Project ALP",
      projectKey: "ALP",
      statusName: "Review",
    });
    expect(alpha.decisions[0]?.statusName).toBe("Approve");
    expect(alpha.working[0]?.statusName).toBe("Draft");
    expect((orgs[1] as OrgInbox).work.map((i) => i.id)).toEqual([forSam]);

    // Lee is in Beta and Gamma: Sam's work in Beta isn't Lee's, and Alpha never shows.
    const leeOrgs = ok<{ orgs: OrgInbox[] }>(await as(lee)("flow.inbox.all", {})).orgs;
    expect(leeOrgs.map((o) => o.orgId)).toEqual([b, c]);
    expect(leeOrgs[0]?.work).toEqual([]);
    expect(leeOrgs[1]?.work.map((i) => i.projectKey)).toEqual(["GAM"]);

    // Someone in no org gets none; an agent can't span orgs.
    expect(ok(await as(await person("Nobody"))("flow.inbox.all", {}))).toEqual({ orgs: [] });
    const agent: Caller = { kind: "agent", id: wa.agent.id, orgId: a, onBehalfOf: sam };
    expect(await call("flow.inbox.all", {}, { d1, actor: agent })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("flow.inbox.get and flow.board.get items carry their project and status names", async () => {
    const sam = await person("Sam");
    const a = await org("A", [sam]);
    const w = await world(a, sam, "ACM");
    const id = await w.item("Post", "review");
    const inbox = ok<{ work: Listed[] }>(await w.op("flow.inbox.get", {}));
    expect(inbox.work).toEqual([
      expect.objectContaining({
        id,
        projectId: w.project.id,
        projectName: "Project ACM",
        projectKey: "ACM",
        statusName: "Review",
      }),
    ]);
    const board = ok<{ columns: { items: Listed[] }[] }>(
      await w.op("flow.board.get", { projectId: w.project.id }),
    );
    expect(board.columns[1]?.items[0]).toMatchObject({
      id,
      projectName: "Project ACM",
      projectKey: "ACM",
      statusName: "Review",
    });
  });

  it("flow.project.list counts each project's open items", async () => {
    const sam = await person("Sam");
    const a = await org("A", [sam]);
    const w = await world(a, sam, "ACM");
    await w.item("Drafting");
    await w.item("Reviewing", "review");
    await w.item("Done", "done");
    const projects = ok<{ projects: { key: string; openCount: number }[] }>(
      await w.op("flow.project.list", {}),
    ).projects;
    expect(projects.map((p) => [p.key, p.openCount])).toEqual([["ACM", 2]]);
  });

  it("flow.run.list by agent: newest first, capped; flow.run.get; the org boundary", async () => {
    const sam = await person("Sam");
    const lee = await person("Lee");
    const a = await org("A", [sam]);
    const b = await org("B", [lee]);
    const w = await world(a, sam, "ACM");
    for (const title of ["One", "Two", "Three"]) await w.item(title);
    const runs = ok<{
      runs: { id: string; itemId: string; itemTitle: string; itemNumber: number }[];
    }>(await w.op("flow.run.list", { agentId: w.agent.id, limit: 2 })).runs;
    expect(runs.map((r) => [r.itemTitle, r.itemNumber])).toEqual([
      ["Three", 3],
      ["Two", 2],
    ]);
    expect(
      ok<{ runs: unknown[] }>(await w.op("flow.run.list", { agentId: w.agent.id })).runs,
    ).toHaveLength(3);
    expect(await w.op("flow.run.list", { agentId: w.agent.id, limit: 51 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    const byItem = ok<{ runs: { projectKey: string }[] }>(
      await w.op("flow.run.list", { itemId: runs[0]?.itemId }),
    ).runs;
    expect(byItem.map((r) => r.projectKey)).toEqual(["ACM"]);

    const runId = runs[0]?.id;
    expect(ok(await w.op("flow.run.get", { runId }))).toEqual({
      run: expect.objectContaining({
        id: runId,
        agentId: w.agent.id,
        status: "queued",
        itemTitle: "Three",
        itemNumber: 3,
        projectKey: "ACM",
      }),
    });
    // Lee, in org B, names A's run and A's agent under B: not found.
    expect(await as(lee)("flow.run.get", { orgId: b, runId })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await as(lee)("flow.run.list", { orgId: b, agentId: w.agent.id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("flow.agent.list says what each agent is working on", async () => {
    const sam = await person("Sam");
    const a = await org("A", [sam]);
    const w = await world(a, sam, "ACM");
    const id = await w.item("Drafting");
    const agents = ok<{ agents: { id: string; workingOn: unknown }[] }>(
      await w.op("flow.agent.list", {}),
    ).agents;
    expect(agents).toEqual([
      expect.objectContaining({
        id: w.agent.id,
        workingOn: { itemId: id, itemTitle: "Drafting", itemNumber: 1, projectKey: "ACM" },
      }),
    ]);
    ok(await w.op("flow.item.move", { itemId: id, to: "review" }));
    expect(
      ok<{ agents: { workingOn: unknown }[] }>(await w.op("flow.agent.list", {})).agents[0]
        ?.workingOn,
    ).toBeNull();
  });

  it("an agent's summary comment and its run.ended event carry the run's id", async () => {
    const sam = await person("Sam");
    const a = await org("A", [sam]);
    const w = await world(a, sam, "ACM");
    const id = await w.item("Post");
    const [run] = ok<{ runs: { id: string }[] }>(await w.op("flow.run.list", { itemId: id })).runs;
    if (!run) throw new Error("no run");
    // As a runner's claim leaves it.
    await d1
      .prepare("UPDATE flow_runs SET status = 'claimed', fencing_token = 1 WHERE id = ?")
      .bind(run.id)
      .run();
    await finishRun(d1, run.id, 1, { outcome: "done", summary: "Drafted it." });
    const { entries } = ok<{
      entries: { kind: string; data: { type?: string; text?: string; runId?: string } }[];
    }>(await w.op("flow.timeline.get", { itemId: id }));
    expect(entries.find((e) => e.kind === "comment")?.data).toEqual({
      text: "Drafted it.",
      runId: run.id,
    });
    expect(entries.find((e) => e.data.type === "run.ended")?.data).toMatchObject({
      runId: run.id,
    });
  });
});
