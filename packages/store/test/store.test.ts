import { env } from "cloudflare:workers";
import { type Actor, FlowError } from "@software-factory/flow";
import { describe, expect, it } from "vitest";
import {
  addComment,
  applyEvent,
  board,
  claimRun,
  createAgent,
  createItem,
  createProject,
  createWorkflow,
  expireRuns,
  failRun,
  finishRun,
  getItem,
  getWorkflow,
  inbox,
  itemRuns,
  listWorkflows,
  renewLease,
  StoreError,
  timeline,
  updateWorkflow,
} from "../src/index.ts";

const d1 = env.DB;
const sam: Actor = { kind: "person", id: "sam" };
const MINUTE = 60_000;

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

  it("moves the item on when the run finishes, into the person's inbox, then on when they finish", async () => {
    const { orgId, item, writer, project } = await setup();
    const run = await claim();
    expect(run).toMatchObject({ itemId: item.id, brief: "Draft it.", fencingToken: 1 });
    expect(run.item).toEqual({ title: "Launch post", body: "Announce it." });
    expect(run.agent).toEqual({ id: writer.id, name: "Writer", instructions: "Write well." });
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
    const columns = (await board(d1, project.id)).columns;
    expect(columns.map((c) => [c.status.id, c.items.map((i) => i.id)])).toEqual([
      ["draft", []],
      ["review", []],
      ["done", [item.id]],
    ]);
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
    const entries = await timeline(d1, item.id);
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
