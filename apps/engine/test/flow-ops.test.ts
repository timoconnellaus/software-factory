// The new core through the engine's real routes (spec 70): a person's flow.* calls through the
// client door (/cli/v1/call), and a runner's flow job through the signed channel (claim, heartbeat,
// hand-back), with the item moving from an agent's status to a person's to one nobody owns.
import { env } from "cloudflare:workers";
import {
  ChannelCallError,
  jobSchema,
  PATHS,
  signRunnerRequest,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { base, CAPACITY, claim, type Person, person, post } from "./flow-helpers.ts";
import { all, first, MANIFEST } from "./helpers.ts";

/** Draft (an agent) → Review (the person) → Done (nobody), a project on it, and an item. */
async function draftReviewDone(p: Person) {
  const agent = await p.call<{ id: string }>("flow.agent.create", {
    name: "Writer",
    instructions: "You write short, plain posts.",
  });
  const workflow = await p.call<{ id: string }>("flow.workflow.create", {
    name: "Draft, review, done",
    statuses: [
      {
        id: "draft",
        name: "Draft",
        owner: { kind: "agent", agentId: agent.id },
        brief: "Draft the launch post in under 200 words.",
      },
      { id: "review", name: "Review", owner: { kind: "person", userId: p.userId } },
      { id: "done", name: "Done", owner: { kind: "none" } },
    ],
  });
  const project = await p.call<{ id: string }>("flow.project.create", {
    name: "Blog",
    key: "BLG",
    workflowId: workflow.id,
  });
  const item = await p.call<{ id: string; number: number; statusId: string }>("flow.item.create", {
    projectId: project.id,
    title: "Launch post",
    body: "Announce the new core.",
  });
  return { agent, workflow, project, item };
}

describe("the new core through the engine", () => {
  it("starts an item's run with its agent's model and effort, and none when it has none", async () => {
    const p = await person();
    const { agent } = await draftReviewDone(p);
    const plain = await claim(p);
    expect(plain?.harness.model).toBeUndefined();
    expect(plain?.harness.effort).toBeUndefined();
    const changed = await p.call<{ model: string; effort: string }>("flow.agent.update", {
      agentId: agent.id,
      name: "Writer",
      instructions: "You write short, plain posts.",
      model: "haiku",
      effort: "low",
    });
    expect(changed).toMatchObject({ model: "haiku", effort: "low" });
    const second = await p.call<{ id: string }>("flow.item.create", {
      projectId: (await p.call<{ projects: { id: string }[] }>("flow.project.list", {})).projects[0]
        ?.id,
      title: "Second post",
    });
    expect(second.id).toBeTruthy();
    const job = await claim(p);
    expect(job?.harness).toMatchObject({ model: "haiku", effort: "low" });
    // Left out on update: unchanged. Null: back to the runner's default.
    const kept = await p.call<{ model: string | null }>("flow.agent.update", {
      agentId: agent.id,
      name: "Writer",
      instructions: "Shorter.",
    });
    expect(kept.model).toBe("haiku");
    const cleared = await p.call<{ model: string | null; effort: string | null }>(
      "flow.agent.update",
      { agentId: agent.id, name: "Writer", instructions: "Shorter.", model: null, effort: null },
    );
    expect(cleared).toMatchObject({ model: null, effort: null });
  });

  it("runs an item from an agent's status to a person's to the last, through the real routes", async () => {
    const p = await person();
    const { item } = await draftReviewDone(p);
    expect(item.statusId).toBe("draft");
    await p.call("flow.item.comment", { itemId: item.id, text: "Mention the board." });

    // The runner claims it: a flow job with no repository, its prompt carrying the brief.
    const job = await claim(p);
    if (!job) throw new Error("no job");
    expect(jobSchema.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({ stage: "flow", workItem: { id: item.id, number: 1 } });
    expect(job.jobId).toMatch(/^frun_/);
    expect(job.repo).toBeUndefined();
    expect(job.branch).toBeUndefined();
    expect(job.harness.prompt).toContain("Draft the launch post in under 200 words.");
    expect(job.harness.prompt).toContain("You write short, plain posts.");
    expect(job.harness.prompt).toContain("Mention the board.");
    expect(job.harness.prompt).toContain('"outcome": "done" | "rejected"');
    // The summary is for people on the timeline: it leaves the run's plumbing out.
    expect(job.harness.prompt).toContain(
      "The summary is read by people on the item's timeline: do not mention the result file",
    );
    // Nothing more for it: the run is claimed.
    expect(await claim(p)).toBeNull();

    // It heartbeats: the lease is renewed and no cancel comes back, and nothing is audited.
    const audits = async () =>
      (await all("SELECT id FROM core_audit WHERE actor_id = ?", p.runner.runnerId)).length;
    const auditedBefore = await audits();
    const before = await first<{ lease_expires_at: string }>(
      "SELECT lease_expires_at FROM flow_runs WHERE id = ?",
      job.jobId,
    );
    await new Promise((r) => setTimeout(r, 5));
    const beat = await p.channel.heartbeat({
      manifest: MANIFEST,
      capacity: { ...CAPACITY, light: { max: 2, inUse: 1 } },
      activeJobs: [{ jobId: job.jobId, fencingToken: job.lease.fencingToken }],
    });
    expect(beat.commands).toEqual([]);
    expect(beat.leases.map((l) => l.jobId)).toEqual([job.jobId]);
    const after = await first<{ lease_expires_at: string }>(
      "SELECT lease_expires_at FROM flow_runs WHERE id = ?",
      job.jobId,
    );
    expect(after?.lease_expires_at && before?.lease_expires_at).toBeTruthy();
    expect((after?.lease_expires_at ?? "") > (before?.lease_expires_at ?? "")).toBe(true);
    expect(await audits()).toBe(auditedBefore);

    // A hand-back with a stale fencing token is refused (its own idempotency key: the real
    // hand-back below uses the host's).
    const stale = JSON.stringify({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken - 1,
      outcome: "completed",
      artifactIds: [],
      branch: "",
      result: { outcome: "done", summary: "Too late." },
    });
    const refused = await worker.fetch(
      new Request(`${base}${PATHS.handback(job.jobId)}`, {
        method: "POST",
        headers: await signRunnerRequest({
          key: p.runner.key,
          runner: p.runner.runnerId,
          method: "POST",
          path: PATHS.handback(job.jobId),
          body: stale,
          idempotencyKey: `hand:stale-${job.jobId}`,
        }),
        body: stale,
      }),
      env,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "fenced" });
    // And its repository token is refused: a flow job has none.
    const token = await p.channel.token(job.jobId, job.lease.fencingToken).catch((e) => e);
    expect(token).toBeInstanceOf(ChannelCallError);

    // The agent hands back done: the item is in the person's status and their inbox.
    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
      summary: "Drafted.",
      result: { outcome: "done", summary: "Drafted the post: 150 words." },
    });
    await p.channel.release({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      finalState: "handed_back",
    });
    const moved = await p.call<{ statusId: string; waiting: unknown }>("flow.item.get", {
      itemId: item.id,
    });
    expect(moved).toMatchObject({
      statusId: "review",
      waiting: { on: "person", userId: p.userId },
    });
    const inbox = await p.call<{ work: { id: string }[] }>("flow.inbox.get", {});
    expect(inbox.work.map((i) => i.id)).toEqual([item.id]);

    // The person finishes: the item is in the last status, and the timeline tells the story.
    const done = await p.call<{ statusId: string }>("flow.item.finish", {
      itemId: item.id,
      outcome: "done",
    });
    expect(done.statusId).toBe("done");
    const tl = await p.call<{
      entries: { kind: string; data: { type?: string; to?: string; text?: string } }[];
    }>("flow.timeline.get", { itemId: item.id });
    expect(tl.entries.filter((e) => e.data.type === "entered").map((e) => e.data.to)).toEqual([
      "draft",
      "review",
      "done",
    ]);
    expect(tl.entries.some((e) => e.data.text === "Drafted the post: 150 words.")).toBe(true);
    const runs = await p.call<{ runs: { status: string }[] }>("flow.run.list", { itemId: item.id });
    expect(runs.runs.map((r) => r.status)).toEqual(["done"]);
  });

  it("offers a run only to a runner that serves its org, and keeps the door's envelope", async () => {
    const p = await person();
    const stranger = await person();
    const { item } = await draftReviewDone(p);
    // Another person's runner, with no share into p's org: nothing.
    expect(await claim(stranger)).toBeNull();
    // Nor can that person read the item.
    const res = await post(
      "call",
      { op: "flow.item.get", input: { orgId: p.orgId, itemId: item.id } },
      stranger.token,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
    // A bad input is the door's invalid_input, with details.
    const bad = await post("call", { op: "flow.item.create", input: { orgId: p.orgId } }, p.token);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_input", details: expect.any(Array) });
    // `ops` lists the flow operations beside the old core's.
    const ops = await worker.fetch(
      new Request(`${base}/cli/v1/ops`, { headers: { authorization: `Bearer ${p.token}` } }),
      env,
    );
    const names = ((await ops.json()) as { operations: { name: string }[] }).operations.map(
      (o) => o.name,
    );
    expect(names).toContain("flow.item.create");
    expect(names).toContain("org.list");
    // p's own runner gets it.
    expect((await claim(p))?.workItem.id).toBe(item.id);
  });

  it("fails the run on a hand-back without a valid result", async () => {
    const p = await person();
    const { item } = await draftReviewDone(p);
    const job = await claim(p);
    if (!job) throw new Error("no job");
    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
    });
    const stopped = await p.call<{ statusId: string; error: string | null }>("flow.item.get", {
      itemId: item.id,
    });
    expect(stopped.statusId).toBe("draft");
    expect(stopped.error).toMatch(/valid result/);
    // Its release afterwards is accepted as it is.
    await p.channel.release({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      finalState: "failed",
    });
    // A heartbeat still holding it is told to cancel it.
    const beat = await p.channel.heartbeat({
      manifest: MANIFEST,
      capacity: CAPACITY,
      activeJobs: [{ jobId: job.jobId, fencingToken: job.lease.fencingToken }],
    });
    expect(beat.commands).toEqual([expect.objectContaining({ kind: "cancel", jobId: job.jobId })]);
  });

  it("stores a run's events from the channel, refuses a stale token, and takes the last ones after the hand-back", async () => {
    const p = await person();
    await draftReviewDone(p);
    const job = await claim(p);
    if (!job) throw new Error("no job");
    const audits = async () =>
      (await all("SELECT id FROM core_audit WHERE actor_id = ?", p.runner.runnerId)).length;
    const auditedBefore = await audits();
    let seq = 0;
    const ev = (e: Record<string, unknown>) => ({
      jobId: job.jobId,
      seq: ++seq,
      at: new Date(Date.UTC(2026, 10, 15, 10, 0, seq)).toISOString(),
      ...e,
    });
    const send = (events: unknown[], fencingToken = job.lease.fencingToken) =>
      p.channel.events(job.jobId, {
        fencingToken,
        events: events as Parameters<typeof p.channel.events>[1]["events"],
      });
    await send([
      ev({ type: "job.state", state: "running" }),
      ev({ type: "message", role: "assistant", text: "Drafting it now." }),
      ev({ type: "tool", name: "Write", input: '{"file_path":"post.md"}', id: "tu_1" }),
      ev({ type: "tool.result", toolId: "tu_1", output: "Wrote post.md" }),
    ]);
    // A stale fencing token is refused, and stores nothing.
    const stale = await send(
      [ev({ type: "message", role: "assistant", text: "Not mine." })],
      job.lease.fencingToken - 1,
    ).catch((e) => e);
    expect(stale).toBeInstanceOf(ChannelCallError);
    expect(stale).toMatchObject({ status: 409, code: "fenced" });

    const events = await p.call<{ events: { kind: string; seq: number }[]; done: boolean }>(
      "flow.run.events",
      { runId: job.jobId },
    );
    expect(events.events.map((e) => [e.seq, e.kind])).toEqual([
      [2, "note"],
      [3, "tool"],
      [4, "result"],
    ]);
    expect(events.done).toBe(false);

    await p.channel.handback({
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: "",
      result: { outcome: "done", summary: "Drafted." },
    });
    // The host's last events, flushed after its hand-back: kept.
    await send([
      ev({
        type: "turn",
        outcome: "success",
        usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      ev({ type: "message", role: "assistant", text: "Done." }),
      ev({ type: "job.state", state: "handed_back" }),
    ]);
    const after = await p.call<{ events: { kind: string }[]; done: boolean }>("flow.run.events", {
      runId: job.jobId,
      after: 4,
    });
    expect(after).toMatchObject({ events: [{ kind: "note", text: "Done." }], done: true });
    const { run } = await p.call<{ run: Record<string, unknown> }>("flow.run.get", {
      runId: job.jobId,
    });
    expect(run).toMatchObject({
      status: "done",
      steps: 1,
      tokens: 12,
      costUsd: null,
      runnerName: "M5",
      startedBy: "entering Draft",
    });
    // Machine-frequency: no audit row for any of it.
    expect(await audits()).toBe(auditedBefore);
  });
});
