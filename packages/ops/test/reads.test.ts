// The desktop app's reads: members, the inbox across orgs, items with their project and status
// names, open counts, runs by agent and by id, what each agent works on, and a summary's run.
import { env } from "cloudflare:workers";
import { finishRun, type ReportedEvent, storeRunEvents } from "@software-factory/store";
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

  it("flow.run.get: the run's totals and what started it; flow.run.events pages with `after`", async () => {
    const sam = await person("Sam");
    const a = await org("A", [sam]);
    const w = await world(a, sam, "ACM");
    const id = await w.item("Post");
    const [run] = ok<{ runs: { id: string }[] }>(await w.op("flow.run.list", { itemId: id })).runs;
    if (!run) throw new Error("no run");
    const claimedAt = new Date(Date.now() - 90_000).toISOString();
    await d1
      .prepare(
        "UPDATE flow_runs SET status = 'claimed', fencing_token = 1, claimed_at = ? WHERE id = ?",
      )
      .bind(claimedAt, run.id)
      .run();
    const at = (s: number) => new Date(Date.parse(claimedAt) + s * 1000).toISOString();
    // 600 events: a note, then tool calls and their results.
    const events: ReportedEvent[] = [
      { type: "message", role: "assistant", text: "Plan: write it.", seq: 1, at: at(1) },
    ];
    for (let n = 0; n < 300; n++) {
      const seq = 2 + n * 2;
      events.push(
        {
          type: "tool",
          name: "Read",
          input: JSON.stringify({ file_path: `/Users/sam/w/src/f${n}.ts` }),
          id: `t${n}`,
          seq,
          at: at(2 + n),
        },
        { type: "tool.result", toolId: `t${n}`, output: "ok", seq: seq + 1, at: at(2 + n) },
      );
    }
    await storeRunEvents(d1, run.id, events);
    const live = ok<{ events: { seq: number }[]; truncated: boolean; done: boolean }>(
      await w.op("flow.run.events", { runId: run.id }),
    );
    expect(live.events).toHaveLength(500);
    expect(live.events[0]).toEqual({ seq: 1, at: at(1), kind: "note", text: "Plan: write it." });
    expect(live.events[1]).toMatchObject({
      kind: "tool",
      name: "Read",
      label: "w/src/f0.ts",
      toolId: "t0",
    });
    expect(live).toMatchObject({ truncated: false, done: false });
    const next = ok<{ events: { seq: number }[] }>(
      await w.op("flow.run.events", { runId: run.id, after: live.events.at(-1)?.seq }),
    );
    expect(next.events.map((e) => e.seq)).toEqual(Array.from({ length: 101 }, (_, i) => 501 + i));

    await finishRun(d1, run.id, 1, { outcome: "done", summary: "Drafted it." });
    const got = ok<{ run: Record<string, unknown> }>(await w.op("flow.run.get", { runId: run.id }));
    expect(got.run).toMatchObject({
      id: run.id,
      agentName: `Writer ACM`,
      itemTitle: "Post",
      projectId: w.project.id,
      projectKey: "ACM",
      statusName: "Draft",
      startedBy: "entering Draft",
      steps: 300,
      tokens: null,
      costUsd: null,
      runnerName: null,
      eventsTruncated: false,
      eventsRemoved: false,
    });
    expect(got.run.durationMs).toBeGreaterThanOrEqual(89_000);
    expect(
      ok<{ done: boolean }>(await w.op("flow.run.events", { runId: run.id, after: 600 })),
    ).toEqual({
      events: [
        { seq: 601, at: at(301), kind: "result", toolId: "t299", output: "ok", isError: false },
      ],
      truncated: false,
      done: true,
    });
    // The runs list carries the totals too.
    expect(
      ok<{ runs: unknown[] }>(await w.op("flow.run.list", { itemId: id })).runs[0],
    ).toMatchObject({ steps: 300, costUsd: null, tokens: null });
  });

  it("flow.inbox.get's `done`: the items you finished or decided, newest first", async () => {
    const sam = await person("Sam");
    const lee = await person("Lee");
    const a = await org("A", [sam, lee]);
    const w = await world(a, sam, "ACM");
    const first = await w.item("First", "review");
    const second = await w.item("Second", "review");
    await w.item("Untouched", "review");
    ok(await w.op("flow.item.finish", { itemId: first, outcome: "done" }));
    ok(await w.op("flow.item.finish", { itemId: second, outcome: "done" }));
    // Each now waits on a decision: Sam approves the first. Lee's decision isn't Sam's.
    ok(await w.op("flow.item.decide", { itemId: first, decision: "approve" }));
    ok(await as(lee)("flow.item.decide", { orgId: a, itemId: second, decision: "reject" }));
    const inbox = ok<{ done: (Listed & { doneAt: string })[] }>(await w.op("flow.inbox.get", {}));
    expect(inbox.done.map((i) => i.id)).toEqual([first, second]);
    expect(inbox.done[0]).toMatchObject({ projectKey: "ACM", statusName: "Done" });
    const leeDone = ok<{ done: Listed[] }>(await as(lee)("flow.inbox.get", { orgId: a })).done;
    expect(leeDone.map((i) => i.id)).toEqual([second]);
  });

  it("flow.item.get carries the org's declared fields, and an agent keeps its `mcp`", async () => {
    const sam = await person("Sam");
    const a = await org("A", [sam]);
    const w = await world(a, sam, "ACM");
    const id = await w.item("Post");
    expect(ok(await w.op("flow.item.get", { itemId: id }))).toMatchObject({
      id,
      declaredFields: [],
    });
    const made = ok<{ id: string; mcp: string[] }>(
      await w.op("flow.agent.create", { name: "Editor", instructions: "", mcp: ["factory"] }),
    );
    expect(made.mcp).toEqual(["factory"]);
    const listed = () =>
      w
        .op("flow.agent.list", {})
        .then((r) => ok<{ agents: { id: string; mcp: string[] }[] }>(r).agents)
        .then((agents) => agents.find((g) => g.id === made.id)?.mcp);
    expect(await listed()).toEqual(["factory"]);
    // Left out on update: kept. Given: replaced, even with none.
    ok(await w.op("flow.agent.update", { agentId: made.id, name: "Editor", instructions: "x" }));
    expect(await listed()).toEqual(["factory"]);
    const cleared = ok<{ mcp: string[] }>(
      await w.op("flow.agent.update", {
        agentId: made.id,
        name: "Editor",
        instructions: "",
        mcp: [],
      }),
    );
    expect(cleared.mcp).toEqual([]);
    expect(await listed()).toEqual([]);
  });
});
