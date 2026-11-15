// A flow run's events (migration 0434): normalised, stored in order once each, capped, totalled on
// the run, read in pages, and pruned 30 days after the run finished. And a gateway changed by id.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createAgent,
  createItem,
  createProject,
  createWorkflow,
  deleteGateway,
  gatewayForHost,
  listGateways,
  normaliseEvent,
  pruneRunEvents,
  type ReportedEvent,
  RUN_EVENT_TEXT_MAX,
  RUN_EVENTS_CAP,
  runEvents,
  runView,
  saveGateway,
  storeRunEvents,
  toolLabel,
} from "../src/index.ts";

const d1 = env.DB;
const DAY = 86_400_000;

/** A queued run on a fresh item, in a fresh org. */
async function aRun() {
  const orgId = `org_${crypto.randomUUID()}`;
  const agent = await createAgent(d1, { orgId, name: "Backend", instructions: "" });
  const wf = await createWorkflow(d1, orgId, {
    name: "Build",
    statuses: [
      { id: "build", name: "Build", owner: { kind: "agent", agentId: agent.id } },
      { id: "done", name: "Done", owner: { kind: "none" } },
    ],
  });
  if (!wf.ok) throw new Error("refused");
  const project = await createProject(d1, {
    orgId,
    name: "API",
    key: "ACM",
    workflowId: wf.workflow.id,
  });
  const item = await createItem(d1, {
    orgId,
    projectId: project.id,
    title: "Rate limits",
    body: "",
    createdBy: "sam",
  });
  const run = await d1
    .prepare("SELECT id FROM flow_runs WHERE item_id = ?")
    .bind(item.id)
    .first<{ id: string }>();
  if (!run) throw new Error("no run");
  return { orgId, runId: run.id };
}

const at = (n: number) => new Date(Date.UTC(2026, 10, 15, 10, 0, n)).toISOString();
const tool = (seq: number, id = `t${seq}`): ReportedEvent => ({
  type: "tool",
  name: "Bash",
  input: JSON.stringify({ command: "go test ./api/...", description: "Run the API tests" }),
  id,
  seq,
  at: at(seq),
});

describe("a run's events", () => {
  it("normalises what the runner sends to notes, tool calls and results, capping each text", () => {
    expect(
      normaliseEvent({ type: "message", role: "assistant", text: " Plan. ", seq: 1, at: at(1) }),
    ).toEqual({ seq: 1, at: at(1), kind: "note", data: { text: "Plan." } });
    // The person's side, logs, status and job states are dropped.
    for (const e of [
      { type: "message", role: "user", text: "do it" },
      { type: "log", text: "…" },
      { type: "agent.status" },
      { type: "job.state" },
      { type: "session.started" },
      { type: "turn" },
    ])
      expect(normaliseEvent({ ...e, seq: 1, at: at(1) })).toBeNull();
    expect(normaliseEvent(tool(2))).toEqual({
      seq: 2,
      at: at(2),
      kind: "tool",
      data: {
        name: "Bash",
        label: "Run the API tests",
        input: '{"command":"go test ./api/...","description":"Run the API tests"}',
        toolId: "t2",
      },
    });
    const long = normaliseEvent({
      type: "tool.result",
      toolId: "t2",
      output: "x".repeat(9_000),
      isError: true,
      seq: 3,
      at: at(3),
    });
    expect(long?.data).toMatchObject({ toolId: "t2", isError: true });
    expect(String(long?.data.output ?? "").length).toBe(RUN_EVENT_TEXT_MAX);
  });

  it("labels a tool call by what it ran on", () => {
    expect(toolLabel("Read", '{"file_path":"/Users/sam/acme/api/router.go"}')).toBe(
      "acme/api/router.go",
    );
    expect(toolLabel("Grep", '{"pattern":"RateLimit","path":"api/"}')).toBe("RateLimit");
    expect(toolLabel("Bash", '{"command":"go test ./..."}')).toBe("go test ./...");
    expect(toolLabel("WebFetch", '{"url":"https://example.com","prompt":"x"}')).toBe(
      "https://example.com",
    );
    expect(toolLabel("mcp__factory__flow_item_get", '{"orgId":"o","itemId":"i"}')).toBe("o");
    expect(toolLabel("Bash", "not json\nsecond line")).toBe("not json");
    expect(toolLabel("Read", undefined)).toBe("");
  });

  it("stores them in order, once each, with the run's steps and tokens", async () => {
    const { runId } = await aRun();
    // Out of order within the batch, with a log between.
    await storeRunEvents(d1, runId, [
      tool(3),
      { type: "log", seq: 2, at: at(2) },
      { type: "message", role: "assistant", text: "Plan.", seq: 1, at: at(1) },
      { type: "tool.result", toolId: "t3", output: "ok", seq: 4, at: at(4) },
    ]);
    // A replay of the same batch, and a later one with a turn's tokens.
    await storeRunEvents(d1, runId, [tool(3)]);
    await storeRunEvents(d1, runId, [
      tool(5),
      {
        type: "turn",
        seq: 6,
        at: at(6),
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4 },
      },
    ]);
    const events = await runEvents(d1, runId);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([
      [1, "note"],
      [3, "tool"],
      [4, "result"],
      [5, "tool"],
    ]);
    expect(await runView(d1, runId)).toMatchObject({ steps: 2, tokens: 334, costUsd: null });
    // A batch of only logs writes nothing.
    const before = await d1
      .prepare("SELECT last_event_seq FROM flow_runs WHERE id = ?")
      .bind(runId)
      .first();
    await storeRunEvents(d1, runId, [{ type: "log", seq: 7, at: at(7) }]);
    expect(
      await d1.prepare("SELECT last_event_seq FROM flow_runs WHERE id = ?").bind(runId).first(),
    ).toEqual(before);
  });

  it(`keeps at most ${RUN_EVENTS_CAP} a run and marks the rest dropped`, async () => {
    const { runId } = await aRun();
    let seq = 0;
    for (let batch = 0; batch < 5; batch++) {
      const events = Array.from({ length: 450 }, () => tool(++seq));
      await storeRunEvents(d1, runId, events);
    }
    const count = await d1
      .prepare("SELECT COUNT(*) AS n, MAX(seq) AS last FROM flow_run_events WHERE run_id = ?")
      .bind(runId)
      .first<{ n: number; last: number }>();
    expect(count).toEqual({ n: RUN_EVENTS_CAP, last: RUN_EVENTS_CAP });
    // Every call counts as a step, kept or not.
    expect(await runView(d1, runId)).toMatchObject({ steps: 2_250, eventsTruncated: true });
    // Pages of at most 500, from `after`.
    expect((await runEvents(d1, runId, 1_900)).map((e) => e.seq)).toEqual(
      Array.from({ length: 100 }, (_, i) => 1_901 + i),
    );
    expect(await runEvents(d1, runId, 0, 10_000)).toHaveLength(500);
  });

  it("prunes a run's events 30 days after it finished, and keeps the run and newer runs' events", async () => {
    const now = Date.now();
    const old = await aRun();
    const recent = await aRun();
    const live = await aRun();
    for (const r of [old, recent, live])
      await storeRunEvents(
        d1,
        r.runId,
        Array.from({ length: 30 }, (_, i) => tool(i + 1)),
      );
    const finish = (runId: string, ms: number) =>
      d1
        .prepare("UPDATE flow_runs SET status = 'done', finished_at = ? WHERE id = ?")
        .bind(new Date(ms).toISOString(), runId)
        .run();
    await finish(old.runId, now - 31 * DAY);
    await finish(recent.runId, now - 29 * DAY);
    // Ten rows a round, two rounds: 20 of the old run's 30 go this tick, the rest the next.
    expect(await pruneRunEvents(d1, now, 10, 2)).toBe(20);
    expect(await runEvents(d1, old.runId)).toHaveLength(10);
    expect(await pruneRunEvents(d1, now, 10, 2)).toBe(10);
    expect(await runEvents(d1, old.runId)).toEqual([]);
    expect(await pruneRunEvents(d1, now, 10, 2)).toBe(0);
    expect(await runView(d1, old.runId, now)).toMatchObject({
      steps: 30,
      eventsRemoved: true,
    });
    expect(await runEvents(d1, recent.runId)).toHaveLength(30);
    expect(await runEvents(d1, live.runId)).toHaveLength(30);
    expect(await runView(d1, recent.runId, now)).toMatchObject({ eventsRemoved: false });
  });
});

describe("a gateway changed by id", () => {
  it("renames it and keeps its secret, sealed again under the new name; deletes by id", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const saved = await saveGateway(d1, "k", {
      orgId,
      name: "blog",
      baseUrl: "https://blog.example",
      auth: { kind: "bearer" },
      secret: "s3cret",
    });
    const renamed = await saveGateway(d1, "k", {
      orgId,
      gatewayId: saved.id,
      name: "cms",
      baseUrl: "https://cms.example",
      auth: { kind: "bearer" },
    });
    expect(renamed).toMatchObject({ id: saved.id, name: "cms", hasSecret: true });
    expect(await gatewayForHost(d1, "k", orgId, "cms")).toMatchObject({ secret: "s3cret" });
    expect(await gatewayForHost(d1, "k", orgId, "blog")).toBeNull();
    // Another org can't change it, and a name the org has is a conflict.
    await expect(
      saveGateway(d1, "k", {
        orgId: `org_${crypto.randomUUID()}`,
        gatewayId: saved.id,
        name: "x",
        baseUrl: "https://x.example",
        auth: { kind: "none" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await saveGateway(d1, "k", {
      orgId,
      name: "other",
      baseUrl: "https://o.example",
      auth: { kind: "none" },
    });
    await expect(
      saveGateway(d1, "k", {
        orgId,
        gatewayId: saved.id,
        name: "other",
        baseUrl: "https://cms.example",
        auth: { kind: "bearer" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await deleteGateway(d1, orgId, { id: saved.id });
    expect((await listGateways(d1, orgId)).map((g) => g.name)).toEqual(["other"]);
  });
});
