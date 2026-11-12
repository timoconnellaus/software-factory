// Watching and steering a run (spec 31, ADR 0400): run.live, run.steer, run.takeSteers.
import { env } from "cloudflare:workers";
import type { CapabilityManifest, Job } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import {
  delivered,
  first,
  newItem,
  ok,
  RUNNER_ACTOR,
  refusal,
  rows,
  uid,
  world,
} from "./helpers.ts";

const manifest = (
  capabilities: CapabilityManifest["capabilities"] = ["hooks", "steer"],
): CapabilityManifest => ({
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities,
});

async function running(capabilities?: CapabilityManifest["capabilities"]) {
  const w = await world();
  const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const actor = RUNNER_ACTOR(runner.runnerId);
  const item = await newItem(w);
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  await ok(
    "job.enqueue",
    { workItemId: item.workItemId, stage: "build", role: "implement", prompt: "Do it" },
    FOREMAN,
  );
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest: manifest(capabilities),
      capacity: { max: 2, inUse: 0, accepting: true },
    },
    actor,
  );
  if (!job) throw new Error("no job");
  return { w, actor, item, job };
}

async function member(orgId: string) {
  const id = uid("usr_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?)",
    ).bind(id, `${id}@example.com`, now, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
    ).bind(uid("mem_"), orgId, id, now),
  ]);
  return { type: "human" as const, id };
}

const at = () => new Date().toISOString();

describe("watching and steering a run", () => {
  it("shows a run's events to any member, after a cursor, with transcript messages", async () => {
    const { w, actor, item, job } = await running();
    await ok(
      "run.reportEvents",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        events: [
          { jobId: job.jobId, seq: 1, at: at(), type: "job.state", state: "running" },
          { jobId: job.jobId, seq: 2, at: at(), type: "agent.status", status: "working" },
          { jobId: job.jobId, seq: 3, at: at(), type: "tool", name: "Read", input: "{}" },
          {
            jobId: job.jobId,
            seq: 4,
            at: at(),
            type: "message",
            role: "assistant",
            text: "Reading the spec.",
          },
          {
            jobId: job.jobId,
            seq: 5,
            at: at(),
            type: "log",
            stream: "terminal",
            text: "> hi",
            screen: true,
          },
        ],
      },
      actor,
    );
    const watcher = await member(w.orgId);
    type Live = {
      run: { runNo: number; active: boolean; runnerName: string };
      events: { seq: number; type: string; data: Record<string, unknown> }[];
      lastSeq: number;
      steer: { allowed: boolean; reason: string | null };
    };
    const all = await ok<Live>("run.live", { workItemId: item.workItemId }, watcher);
    expect(all.run).toMatchObject({ runNo: 1, active: true, runnerName: "M5" });
    expect(all.events.map((e) => e.type)).toEqual([
      "job.state",
      "agent.status",
      "tool",
      "message",
      "log",
    ]);
    expect(all.events[3]?.data).toEqual({ role: "assistant", text: "Reading the spec." });
    expect(all.events[4]?.data).toMatchObject({ screen: true });
    expect(all.lastSeq).toBe(5);
    // A watcher who doesn't own the runner may not steer.
    expect(all.steer.allowed).toBe(false);
    expect(all.steer.reason).toMatch(/runner's owner/);

    const after = await ok<Live>("run.live", { workItemId: item.workItemId, afterSeq: 3 }, w.human);
    expect(after.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(after.steer.allowed).toBe(true);

    // Someone outside the org can't watch.
    const stranger = { type: "human" as const, id: uid("usr_") };
    expect((await refusal(ok("run.live", { workItemId: item.workItemId }, stranger))).code).toMatch(
      /forbidden|not_found/,
    );
  });

  it("keeps an answer within its size budget: the newest first, then onward from a cursor", async () => {
    const { w, actor, item, job } = await running();
    const big = "x".repeat(60_000);
    await ok(
      "run.reportEvents",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        events: Array.from({ length: 10 }, (_, i) => ({
          jobId: job.jobId,
          seq: i + 1,
          at: at(),
          type: "log",
          stream: "terminal",
          text: big,
        })),
      },
      actor,
    );
    type Live = { events: { seq: number }[]; lastSeq: number; truncated: boolean };
    const firstRead = await ok<Live>("run.live", { workItemId: item.workItemId }, w.human);
    expect(firstRead.events.length).toBeLessThan(10);
    expect(firstRead.events.at(-1)?.seq).toBe(10);
    expect(firstRead.lastSeq).toBe(10);
    expect(firstRead.truncated).toBe(true);
    const onward = await ok<Live>(
      "run.live",
      { workItemId: item.workItemId, afterSeq: 0 },
      w.human,
    );
    expect(onward.events[0]?.seq).toBe(1);
    expect(onward.lastSeq).toBe(onward.events.at(-1)?.seq);
    expect(onward.lastSeq).toBeLessThan(10);
  });

  it("lets only the runner's owner steer, journals it, and hands it to the host once", async () => {
    const { w, actor, item, job } = await running();
    const live = await ok<{ run: { id: string } }>(
      "run.live",
      { workItemId: item.workItemId },
      w.human,
    );
    const runId = live.run.id;
    const before = delivered.length;
    const sent = await ok<{ steerId: string; text: string }>(
      "run.steer",
      {
        workItemId: item.workItemId,
        runId,
        text: "also\nupdate the changelog‮\u0007",
      },
      w.human,
    );
    expect(sent.text).toBe("also update the changelog");
    // Journalled, naming who sent it, and the host's wait is woken.
    const audit = await first<{ actor_id: string; outcome: string }>(
      "SELECT actor_id, outcome FROM core_audit WHERE operation = 'run.steer' AND work_item_id = ?",
      item.workItemId,
    );
    expect(audit).toEqual({ actor_id: w.userId, outcome: "ok" });
    const outbox = delivered.slice(before).flat();
    expect(outbox.length).toBeGreaterThan(0);

    // A member who doesn't own the runner is refused.
    const watcher = await member(w.orgId);
    expect(
      (await refusal(ok("run.steer", { workItemId: item.workItemId, runId, text: "hi" }, watcher)))
        .code,
    ).toBe("forbidden");

    // The host takes it once.
    type Taken = { steers: { id: string; text: string }[] };
    const taken = await ok<Taken>(
      "run.takeSteers",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken },
      actor,
    );
    expect(taken.steers).toEqual([
      expect.objectContaining({ id: sent.steerId, text: "also update the changelog" }),
    ]);
    const again = await ok<Taken>(
      "run.takeSteers",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken },
      actor,
    );
    expect(again.steers).toEqual([]);
    const view = await ok<{ steers: { status: string; authorUserId: string }[] }>(
      "run.live",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.steers).toEqual([
      expect.objectContaining({ status: "delivered", authorUserId: w.userId }),
    ]);

    // A stale fencing token, or another runner, can't take a run's steers.
    expect(
      (
        await refusal(
          ok(
            "run.takeSteers",
            { jobId: job.jobId, fencingToken: job.lease.fencingToken + 7 },
            actor,
          ),
        )
      ).code,
    ).toBe("fenced");
    const other = await ok<{ runnerId: string }>("runner.register", { name: "other" }, w.human);
    expect(
      (
        await refusal(
          ok(
            "run.takeSteers",
            { jobId: job.jobId, fencingToken: job.lease.fencingToken },
            RUNNER_ACTOR(other.runnerId),
          ),
        )
      ).code,
    ).toBe("forbidden");
  });

  it("refuses a steer for a runner without `steer` and for an ended run", async () => {
    const old = await running(["hooks"]);
    const oldLive = await ok<{ run: { id: string }; steer: { allowed: boolean } }>(
      "run.live",
      { workItemId: old.item.workItemId },
      old.w.human,
    );
    expect(oldLive.steer.allowed).toBe(false);
    expect(
      (
        await refusal(
          ok(
            "run.steer",
            { workItemId: old.item.workItemId, runId: oldLive.run.id, text: "hi" },
            old.w.human,
          ),
        )
      ).code,
    ).toBe("unavailable");

    const { w, actor, item, job } = await running();
    const live = await ok<{ run: { id: string } }>(
      "run.live",
      { workItemId: item.workItemId },
      w.human,
    );
    await ok(
      "run.steer",
      { workItemId: item.workItemId, runId: live.run.id, text: "never typed" },
      w.human,
    );
    await ok(
      "run.release",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken, finalState: "failed" },
      actor,
    );
    expect(
      (
        await refusal(
          ok(
            "run.steer",
            { workItemId: item.workItemId, runId: live.run.id, text: "too late" },
            w.human,
          ),
        )
      ).code,
    ).toBe("conflict");
    const view = await ok<{ steers: { status: string }[] }>(
      "run.live",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.steers.map((s) => s.status)).toEqual(["undelivered"]);
    expect(
      await rows("SELECT id FROM core_run_steers WHERE work_item_id = ?", item.workItemId),
    ).toHaveLength(1);
  });
});
