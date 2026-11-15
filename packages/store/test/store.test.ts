import { env } from "cloudflare:workers";
import { type Actor, FlowError } from "@software-factory/flow";
import { describe, expect, it } from "vitest";
import {
  addComment,
  agentRuns,
  applyEvent,
  board,
  claimRun,
  createAgent,
  createItem,
  createProject,
  createWorkflow,
  endRun,
  expireRun,
  expireRuns,
  failRun,
  finishRun,
  getItem,
  getListedRun,
  getWorkflow,
  inbox,
  itemBranch,
  itemRuns,
  listAgents,
  listProjects,
  listWorkflows,
  recentComments,
  renewLease,
  StoreError,
  setProjectRepo,
  stopItem,
  timeline,
  updateWorkflow,
} from "../src/index.ts";

const d1 = env.DB;
const sam: Actor = { kind: "person", id: "sam" };
const MINUTE = 60_000;

/** Runners as core_runners has them: runner_1 and runner_2 are sam's, runner_3 is pat's. */
await d1.batch(
  [
    ["runner_1", "sam"],
    ["runner_2", "sam"],
    ["runner_3", "pat"],
  ].map(([id, owner]) =>
    d1
      .prepare(
        "INSERT OR IGNORE INTO core_runners (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(id, owner, id, new Date().toISOString()),
  ),
);

/** An org with an agent and a project on "Draft (agent) → Review (sam) → Done". */
async function setup() {
  const orgId = `org_${crypto.randomUUID()}`;
  const writer = await createAgent(d1, { orgId, name: "Writer", instructions: "Write well." });
  const created = await createWorkflow(d1, orgId, {
    name: "Draft, review, done",
    statuses: [
      {
        id: "draft",
        name: "Draft",
        owner: { kind: "agent", agentId: writer.id },
        brief: "Draft it.",
      },
      { id: "review", name: "Review", owner: { kind: "person", userId: "sam" } },
      { id: "done", name: "Done", owner: { kind: "none" } },
    ],
  });
  if (!created.ok) throw new Error("workflow refused");
  const project = await createProject(d1, {
    orgId,
    name: "Acme",
    key: "ACM",
    workflowId: created.workflow.id,
  });
  const item = await createItem(d1, {
    orgId,
    projectId: project.id,
    title: "Launch post",
    body: "Announce it.",
    createdBy: "sam",
  });
  // claimRun and expireRuns take the oldest run of any org: leave only this item's runs open.
  await d1
    .prepare(
      "UPDATE flow_runs SET status = 'cancelled' WHERE status IN ('queued', 'claimed') AND item_id != ?",
    )
    .bind(item.id)
    .run();
  return { orgId, writer, workflowId: created.workflow.id, project, item };
}

async function claim(now = Date.now()) {
  const run = await claimRun(d1, "runner_1", now, MINUTE);
  if (!run) throw new Error("nothing to claim");
  return run;
}

describe("workflows", () => {
  it("refuses a workflow that points at a missing status, and stores a valid one", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const refused = await createWorkflow(d1, orgId, {
      name: "Broken",
      statuses: [{ id: "a", name: "A", owner: { kind: "none" }, onDone: "nowhere" }],
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems[0]?.message).toContain("nowhere");
    expect(await listWorkflows(d1, orgId)).toEqual([]);

    const created = await createWorkflow(d1, orgId, {
      name: "One",
      statuses: [{ id: "a", name: "A", owner: { kind: "none" } }],
    });
    if (!created.ok) throw new Error("refused");
    const updated = await updateWorkflow(d1, created.workflow.id, {
      name: "One",
      statuses: [{ id: "a", name: "A", owner: { kind: "none" }, onDone: "b" }],
    });
    expect(updated.ok).toBe(false);
    expect((await getWorkflow(d1, created.workflow.id))?.workflow.statuses).toHaveLength(1);
  });
});

describe("items and runs", () => {
  it("queues exactly one run with the brief when an item enters an agent's status", async () => {
    const { item, writer } = await setup();
    expect(item).toMatchObject({ number: 1, statusId: "draft", stay: 1 });
    expect(item.waiting).toEqual({ on: "run", agentId: writer.id });
    const runs = await itemRuns(d1, item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", brief: "Draft it.", stay: 1 });
  });

  it("gives a run on a project with a repository the item's branch, and keeps the head it pushed", async () => {
    const { item, project } = await setup();
    expect(itemBranch("A_c m!", 3)).toBe("factory/flow-a-c-m-3");
    await setProjectRepo(d1, project.id, {
      owner: "acme",
      name: "app",
      defaultBranch: "main",
      installationId: "42",
    });
    const run = await claim();
    expect(run.project).toEqual({
      key: "ACM",
      repo: { owner: "acme", name: "app", defaultBranch: "main", installationId: "42" },
    });
    expect(run.item).toMatchObject({
      branch: "factory/flow-acm-1",
      firstOnBranch: true,
      headSha: null,
    });
    expect((await getItem(d1, item.id))?.branch).toBe("factory/flow-acm-1");
    // The run's own branch's head is kept, on the run and the item.
    const head = "a".repeat(40);
    const ended = await endRun(d1, run.id, run.fencingToken, {
      status: "done",
      result: { outcome: "done", summary: "Built." },
      pushed: { branch: "factory/flow-acm-1", headSha: head },
    });
    expect(ended.run).toMatchObject({ branch: "factory/flow-acm-1", headSha: head });
    expect(ended.item).toMatchObject({
      statusId: "review",
      branch: "factory/flow-acm-1",
      headSha: head,
    });
    expect((await getItem(d1, item.id))?.headSha).toBe(head);
    // The next run on the item reuses the branch; a head for another branch is not kept.
    await applyEvent(d1, item.id, { type: "moved", by: sam, to: "draft" }, sam);
    const next = await claim();
    expect(next.item).toMatchObject({
      branch: "factory/flow-acm-1",
      firstOnBranch: false,
      headSha: head,
    });
    const other = await endRun(d1, next.id, next.fencingToken, {
      status: "done",
      result: { outcome: "done", summary: "Again." },
      pushed: { branch: "factory/flow-other-1", headSha: "b".repeat(40) },
    });
    expect(other.run.headSha).toBeNull();
    expect(other.item.headSha).toBe(head);
  });

  it("moves the item on when the run finishes, into the person's inbox, then on when they finish", async () => {
    const { orgId, item, writer, project } = await setup();
    const run = await claim();
    expect(run).toMatchObject({ itemId: item.id, brief: "Draft it.", fencingToken: 1 });
    // A project without a repository: no branch for the item.
    expect(run.item).toEqual({
      number: 1,
      title: "Launch post",
      body: "Announce it.",
      branch: null,
      firstOnBranch: false,
      headSha: null,
    });
    expect(run.project).toMatchObject({ repo: null });
    expect(run.agent).toEqual({
      id: writer.id,
      name: "Writer",
      instructions: "Write well.",
      mcp: [],
    });
    expect(await claimRun(d1, "runner_2", Date.now(), MINUTE)).toBeNull();

    const moved = await finishRun(d1, run.id, run.fencingToken, {
      outcome: "done",
      summary: "Drafted.",
    });
    expect(moved).toMatchObject({ statusId: "review", waiting: { on: "person", userId: "sam" } });
    expect((await inbox(d1, orgId, "sam")).work.map((i) => i.id)).toEqual([item.id]);
    expect((await itemRuns(d1, item.id))[0]).toMatchObject({
      status: "done",
      result: { outcome: "done", summary: "Drafted." },
    });

    const done = await applyEvent(
      d1,
      item.id,
      { type: "person.finished", by: sam, outcome: "done" },
      sam,
    );
    expect(done).toMatchObject({ statusId: "done", waiting: { on: "nothing" } });
    expect((await inbox(d1, orgId, "sam")).work).toEqual([]);
    const view = await board(d1, project.id);
    expect(view.truncated).toBe(false);
    expect(view.columns.map((c) => [c.status.id, c.items.map((i) => i.id)])).toEqual([
      ["draft", []],
      ["review", []],
      ["done", [item.id]],
    ]);
  });

  it("only hands a runner runs it serves: its owner's items, or an org it is shared into", async () => {
    const { orgId, item } = await setup();
    // runner_3 is pat's, and sam created the item.
    expect(await claimRun(d1, "runner_3", Date.now(), MINUTE)).toBeNull();
    await d1
      .prepare(
        "INSERT INTO core_runner_shares (runner_id, scope, scope_id, created_at) VALUES ('runner_3', 'org', ?, ?)",
      )
      .bind(orgId, new Date().toISOString())
      .run();
    const run = await claimRun(d1, "runner_3", Date.now(), MINUTE);
    expect(run).toMatchObject({ itemId: item.id, orgId, item: { number: 1 } });
    await d1.prepare("DELETE FROM core_runner_shares WHERE runner_id = 'runner_3'").run();
  });

  it("caps the board, the inbox and the timeline, and says so", async () => {
    const { orgId, project, item } = await setup();
    // 501 more items straight into the table, waiting on sam: past the board's and inbox's caps.
    const now = new Date().toISOString();
    const rows = Array.from({ length: 501 }, (_, i) =>
      d1
        .prepare(
          `INSERT INTO flow_items (id, org_id, project_id, number, title, body, status_id, waiting_on,
             waiting_ref, error, stay, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 't', '', 'review', 'person', 'sam', NULL, 1, 'sam', ?, ?)`,
        )
        .bind(`fitm_cap_${orgId}_${i}`, orgId, project.id, 100 + i, now, now),
    );
    await d1.batch(rows);
    const view = await board(d1, project.id);
    expect(view.truncated).toBe(true);
    expect(view.columns.flatMap((c) => c.items)).toHaveLength(500);
    const waiting = await inbox(d1, orgId, "sam");
    expect(waiting).toMatchObject({ truncated: true, decisions: [] });
    expect(waiting.work).toHaveLength(100);

    // 505 comments after the item's 3 entries: the timeline keeps the newest 500, in order.
    await d1.batch(
      Array.from({ length: 505 }, (_, i) =>
        d1
          .prepare(
            `INSERT INTO flow_events (id, org_id, item_id, seq, kind, actor, data, created_at)
             VALUES (?, ?, ?, ?, 'comment', ?, ?, ?)`,
          )
          .bind(
            `fev_cap_${item.id}_${i}`,
            orgId,
            item.id,
            4 + i,
            JSON.stringify(sam),
            JSON.stringify({ text: `c${i}` }),
            now,
          ),
      ),
    );
    const { entries, truncated } = await timeline(d1, item.id);
    expect(truncated).toBe(true);
    expect(entries).toHaveLength(500);
    expect(entries.at(-1)?.data).toEqual({ text: "c504" });
    expect(entries.map((e) => e.seq)).toEqual([...entries.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it("stops the item when the run fails, and a retry queues a new run", async () => {
    const { item } = await setup();
    const run = await claim();
    const stopped = await failRun(d1, run.id, run.fencingToken, "Out of tokens.");
    expect(stopped).toMatchObject({
      statusId: "draft",
      error: "Out of tokens.",
      waiting: { on: "nothing" },
    });

    const retried = await applyEvent(d1, item.id, { type: "retried", by: sam }, sam);
    expect(retried).toMatchObject({ error: null, stay: 2, waiting: { on: "run" } });
    const runs = await itemRuns(d1, item.id);
    expect(runs.map((r) => [r.stay, r.status])).toEqual([
      [1, "failed"],
      [2, "queued"],
    ]);
  });

  it("refuses a stale fencing token and writes nothing", async () => {
    const { item } = await setup();
    const run = await claim();
    const stale = finishRun(d1, run.id, run.fencingToken - 1, { outcome: "done", summary: "" });
    await expect(stale).rejects.toMatchObject({ code: "stale_run" });
    expect(await getItem(d1, item.id)).toMatchObject({ statusId: "draft", stay: 1 });
    expect((await itemRuns(d1, item.id))[0]?.status).toBe("claimed");
  });

  it("fails a run whose lease lapsed, and not one whose lease was renewed", async () => {
    const { item } = await setup();
    const now = Date.now();
    const run = await claim(now);
    expect(await renewLease(d1, run.id, "runner_1", now + MINUTE / 2, MINUTE)).toBe(true);
    expect(await renewLease(d1, run.id, "runner_2", now, MINUTE)).toBe(false);
    expect(await expireRuns(d1, now + MINUTE, 10)).toBe(0);
    expect(await expireRuns(d1, now + 2 * MINUTE, 10)).toBe(1);
    expect(await getItem(d1, item.id)).toMatchObject({ error: "The runner stopped responding." });
    expect((await itemRuns(d1, item.id))[0]?.status).toBe("failed");
  });

  it("doesn't expire a run whose lease was renewed after the sweep read it as lapsed", async () => {
    const { item } = await setup();
    const now = Date.now();
    const run = await claim(now);
    // The sweep at now + 2 minutes read the lease as lapsed; the runner renews before it writes.
    expect(await renewLease(d1, run.id, "runner_1", now + 2 * MINUTE, MINUTE)).toBe(true);
    expect(await expireRun(d1, run.id, run.fencingToken, now + 2 * MINUTE)).toBeNull();
    expect((await itemRuns(d1, item.id))[0]?.status).toBe("claimed");
    expect(await getItem(d1, item.id)).toMatchObject({ error: null, waiting: { on: "run" } });
    expect(await expireRun(d1, run.id, run.fencingToken, now + 4 * MINUTE)).toBeTruthy();
  });

  it("lets only one of two concurrent events advance an item", async () => {
    const { item } = await setup();
    const results = await Promise.allSettled([
      applyEvent(d1, item.id, { type: "moved", by: sam, to: "review" }, sam),
      applyEvent(d1, item.id, { type: "moved", by: sam, to: "done" }, sam),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(StoreError);
    expect(rejected?.reason).toMatchObject({ code: "conflict" });
    expect((await getItem(d1, item.id))?.stay).toBe(2);
  });

  it("passes a kernel refusal through and writes nothing", async () => {
    const { item } = await setup();
    const before = await timeline(d1, item.id);
    const refused = applyEvent(d1, item.id, { type: "decided", by: sam, decision: "approve" }, sam);
    await expect(refused).rejects.toBeInstanceOf(FlowError);
    expect(await timeline(d1, item.id)).toEqual(before);
  });

  it("returns the timeline in order: events, their effects, and comments", async () => {
    const { item, writer } = await setup();
    await addComment(d1, item.id, sam, "Keep it short.");
    const run = await claim();
    await finishRun(d1, run.id, run.fencingToken, { outcome: "done", summary: "Drafted." });
    const { entries } = await timeline(d1, item.id);
    // The agent's summary, and the run.ended event, carry the run.
    expect((await recentComments(d1, item.id, 1)).map((c) => c.data)).toEqual([
      { text: "Drafted.", runId: run.id },
    ]);
    expect(entries.find((e) => e.kind === "event" && e.seq === 5)?.data).toEqual({
      type: "run.ended",
      stay: 1,
      outcome: "done",
      runId: run.id,
    });
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
    expect(
      entries.map((e) => [
        e.kind,
        (e.data as { type?: string; text?: string }).type ?? (e.data as { text: string }).text,
      ]),
    ).toEqual([
      ["event", "created"],
      ["effect", "entered"],
      ["effect", "run.start"],
      ["comment", "Keep it short."],
      ["event", "run.ended"],
      ["effect", "entered"],
      ["effect", "inbox.add"],
      ["comment", "Drafted."],
    ]);
    expect(entries.at(-1)?.actor).toEqual({ kind: "agent", id: writer.id });
  });
});

describe("the desktop app's reads", () => {
  it("lists items with their project's name and key and their status's name", async () => {
    const { orgId, project, item } = await setup();
    const named = { projectId: project.id, projectName: "Acme", projectKey: "ACM" };
    const view = await board(d1, project.id);
    expect(view.columns[0]?.items[0]).toMatchObject({
      id: item.id,
      ...named,
      statusName: "Draft",
    });
    const run = await claim();
    await finishRun(d1, run.id, run.fencingToken, { outcome: "done", summary: "" });
    expect((await inbox(d1, orgId, "sam")).work).toEqual([
      expect.objectContaining({ id: item.id, ...named, statusName: "Review" }),
    ]);
  });

  it("counts each project's open items: waiting on something, or stopped with an error", async () => {
    const { orgId, project, item, workflowId } = await setup();
    await createProject(d1, { orgId, name: "Quiet", key: "QT", workflowId });
    const add = (title: string) =>
      createItem(d1, { orgId, projectId: project.id, title, body: "", createdBy: "sam" });
    const second = await add("Second");
    const third = await add("Third");
    const counts = async () =>
      Object.fromEntries((await listProjects(d1, orgId)).map((p) => [p.key, p.openCount]));
    expect(await counts()).toEqual({ ACM: 3, QT: 0 });
    // Done (nobody owns it, no error) isn't open; stopped with an error is.
    await applyEvent(d1, item.id, { type: "moved", by: sam, to: "done" }, sam);
    await stopItem(d1, second.id, "broke");
    expect(await counts()).toEqual({ ACM: 2, QT: 0 });
    await applyEvent(d1, third.id, { type: "moved", by: sam, to: "done" }, sam);
    expect(await counts()).toEqual({ ACM: 1, QT: 0 });
  });

  it("lists an agent's runs newest first, capped, with their items", async () => {
    const { orgId, project, writer } = await setup();
    for (const title of ["Two", "Three"]) {
      await createItem(d1, { orgId, projectId: project.id, title, body: "", createdBy: "sam" });
    }
    const runs = await agentRuns(d1, orgId, writer.id, 2);
    expect(runs.map((r) => [r.itemTitle, r.itemNumber, r.projectKey])).toEqual([
      ["Three", 3, "ACM"],
      ["Two", 2, "ACM"],
    ]);
    expect(await agentRuns(d1, orgId, writer.id, 500)).toHaveLength(3);
    // The same agent under another org's id finds nothing.
    expect(await agentRuns(d1, "org_other", writer.id, 20)).toEqual([]);
    expect(await getListedRun(d1, runs[0]?.id ?? "")).toMatchObject({
      itemTitle: "Three",
      itemNumber: 3,
      projectKey: "ACM",
    });
  });

  it("says what each agent is working on: its claimed run, else its oldest queued one", async () => {
    const { orgId, project, item } = await setup();
    await createAgent(d1, { orgId, name: "Idle", instructions: "" });
    const later = await createItem(d1, {
      orgId,
      projectId: project.id,
      title: "Later",
      body: "",
      createdBy: "sam",
    });
    const working = async () =>
      Object.fromEntries((await listAgents(d1, orgId)).map((a) => [a.name, a.workingOn]));
    expect(await working()).toEqual({
      Idle: null,
      Writer: { itemId: item.id, itemTitle: "Launch post", itemNumber: 1, projectKey: "ACM" },
    });
    // The later item's run is claimed: a claimed run comes before a queued one.
    await d1
      .prepare("UPDATE flow_runs SET status = 'claimed' WHERE item_id = ?")
      .bind(later.id)
      .run();
    expect((await working()).Writer).toEqual({
      itemId: later.id,
      itemTitle: "Later",
      itemNumber: 2,
      projectKey: "ACM",
    });
  });
});
