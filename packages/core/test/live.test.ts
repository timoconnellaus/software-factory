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
  it("stores a run of log lines as one row and shows every line, from any cursor", async () => {
    const { w, actor, item, job } = await running();
    const log = (seq: number, text = `line ${seq}`) => ({
      jobId: job.jobId,
      seq,
      at: at(),
      type: "log" as const,
      stream: "terminal" as const,
      text,
    });
    await ok(
      "run.reportEvents",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        events: [
          { jobId: job.jobId, seq: 1, at: at(), type: "job.state", state: "running" },
          log(2),
          log(3),
          log(4),
          { jobId: job.jobId, seq: 5, at: at(), type: "agent.status", status: "working" },
          log(6),
          // Long lines: a row stops at 64 KB, so each of these is about a row of its own.
          ...Array.from({ length: 20 }, (_, i) => log(7 + i, "y".repeat(60_000))),
        ],
      },
      actor,
    );
    const stored = await rows<{ seq: number; last_seq: number | null }>(
      "SELECT e.seq, e.last_seq FROM core_run_events e JOIN core_runs r ON r.id = e.run_id WHERE r.job_id = ? ORDER BY e.seq",
      job.jobId,
    );
    expect(stored.slice(0, 4)).toEqual([
      { seq: 1, last_seq: null },
      { seq: 2, last_seq: 4 },
      { seq: 5, last_seq: null },
      { seq: 6, last_seq: expect.any(Number) },
    ]);
    const sizes = await rows<{ bytes: number }>(
      "SELECT length(e.payload) AS bytes FROM core_run_events e JOIN core_runs r ON r.id = e.run_id WHERE r.job_id = ?",
      job.jobId,
    );
    expect(Math.max(...sizes.map((r) => r.bytes))).toBeLessThan(130_000);
    type Live = { events: { seq: number; type: string; data: { text?: string } }[] };
    const all = await ok<Live>("run.live", { workItemId: item.workItemId, afterSeq: 0 }, w.human);
    expect(all.events.slice(0, 6).map((e) => [e.seq, e.type, e.data.text ?? null])).toEqual([
      [1, "job.state", null],
      [2, "log", "line 2"],
      [3, "log", "line 3"],
      [4, "log", "line 4"],
      [5, "agent.status", null],
      [6, "log", "line 6"],
    ]);
    // A cursor in the middle of a batch: only the lines after it.
    const after = await ok<Live>("run.live", { workItemId: item.workItemId, afterSeq: 3 }, w.human);
    expect(after.events.slice(0, 3).map((e) => e.seq)).toEqual([4, 5, 6]);
    // A retried batch is a no-op.
    await ok(
      "run.reportEvents",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken, events: [log(2), log(3), log(4)] },
      actor,
    );
    const again = await rows(
      "SELECT 1 FROM core_run_events e JOIN core_runs r ON r.id = e.run_id WHERE r.job_id = ?",
      job.jobId,
    );
    expect(again.length).toBe(stored.length);
  });

  it("caps a stored batch at 200 lines, and pages a first read by lines and bytes, not rows", async () => {
    const { w, actor, item, job } = await running();
    const log = (seq: number) => ({
      jobId: job.jobId,
      seq,
      at: at(),
      type: "log" as const,
      stream: "terminal" as const,
      text: `line ${seq}`,
    });
    // 1,500 lines in three calls of 500: 200 lines a row at most.
    for (let call = 0; call < 3; call++) {
      await ok(
        "run.reportEvents",
        {
          jobId: job.jobId,
          fencingToken: job.lease.fencingToken,
          events: Array.from({ length: 500 }, (_, i) => log(call * 500 + i + 1)),
        },
        actor,
      );
    }
    const stored = await rows<{ seq: number; last_seq: number }>(
      "SELECT e.seq, e.last_seq FROM core_run_events e JOIN core_runs r ON r.id = e.run_id WHERE r.job_id = ? ORDER BY e.seq",
      job.jobId,
    );
    expect(stored).toHaveLength(9);
    expect(stored.every((r) => r.last_seq - r.seq + 1 <= 200)).toBe(true);
    type Live = { events: { seq: number }[]; lastSeq: number };
    const newest = await ok<Live>("run.live", { workItemId: item.workItemId }, w.human);
    expect(newest.events).toHaveLength(300);
    expect(newest.events.at(-1)?.seq).toBe(1500);
    expect(newest.events[0]?.seq).toBe(1201);
    // Walking from the start, a page at a time, reaches every line once.
    const seen: number[] = [];
    let cursor = 0;
    for (let i = 0; i < 10 && cursor < 1500; i++) {
      const page = await ok<Live>(
        "run.live",
        { workItemId: item.workItemId, afterSeq: cursor },
        w.human,
      );
      seen.push(...page.events.map((e) => e.seq));
      cursor = page.lastSeq;
    }
    expect(seen).toEqual(Array.from({ length: 1500 }, (_, i) => i + 1));
  });

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
    // Journalled, naming who sent it, and queued for the host's job line (spec 44 part B).
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

describe("a stream session's chat and takeover (spec 37, ADR 0450)", () => {
  const started = (jobId: string, seq: number, mode?: "terminal" | "stream") => ({
    jobId,
    seq,
    at: at(),
    type: "session.started" as const,
    sessionRef: "s",
    ...(mode ? { mode } : {}),
  });

  it("stores the richer stream events and says the run's mode", async () => {
    const { w, actor, item, job } = await running(["hooks", "steer", "chat"]);
    type Live = {
      run: { id: string; mode: string | null; takeover: { hint: string } | null };
      events: { type: string; data: Record<string, unknown> }[];
      takeover: { allowed: boolean; reason: string | null; requested: boolean };
    };
    const before = await ok<Live>("run.live", { workItemId: item.workItemId }, w.human);
    expect(before.run.mode).toBeNull();
    expect(before.takeover.allowed).toBe(false);
    await ok(
      "run.reportEvents",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        events: [
          started(job.jobId, 1, "stream"),
          {
            jobId: job.jobId,
            seq: 2,
            at: at(),
            type: "tool",
            name: "Bash",
            input: "{}",
            id: "tu_1",
          },
          {
            jobId: job.jobId,
            seq: 3,
            at: at(),
            type: "tool.result",
            toolId: "tu_1",
            output: "ok",
            isError: false,
          },
          {
            jobId: job.jobId,
            seq: 4,
            at: at(),
            type: "turn",
            outcome: "success",
            durationMs: 1000,
            usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
          },
        ],
      },
      actor,
    );
    const view = await ok<Live>("run.live", { workItemId: item.workItemId }, w.human);
    expect(view.run.mode).toBe("stream");
    expect(view.events.map((e) => e.type)).toEqual([
      "session.started",
      "tool",
      "tool.result",
      "turn",
    ]);
    expect(view.events[2]?.data).toEqual({ toolId: "tu_1", output: "ok", isError: false });
    expect(view.takeover).toEqual({ allowed: true, reason: null, requested: false });
    // Oversized fields are refused on the wire.
    expect(
      (
        await refusal(
          ok(
            "run.reportEvents",
            {
              jobId: job.jobId,
              fencingToken: job.lease.fencingToken,
              events: [
                {
                  jobId: job.jobId,
                  seq: 5,
                  at: at(),
                  type: "tool.result",
                  toolId: "tu_1",
                  output: "x".repeat(5_000),
                },
              ],
            },
            actor,
          ),
        )
      ).code,
    ).toBe("invalid_input");

    // The host reports the handover: the resume command becomes the run's takeover.
    await ok(
      "run.reportEvents",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        events: [
          {
            jobId: job.jobId,
            seq: 6,
            at: at(),
            type: "takeover",
            sessionId: "sid-1",
            hint: "cd /w && claude --resume sid-1",
          },
        ],
      },
      actor,
    );
    const handed = await ok<Live>("run.live", { workItemId: item.workItemId }, w.human);
    expect(handed.run.takeover).toEqual({
      label: "Resume in a terminal",
      hint: "cd /w && claude --resume sid-1",
    });
  });

  it("lets only the runner's owner take a stream session over, once, and hands it to the host", async () => {
    const { w, actor, item, job } = await running(["hooks", "steer", "chat"]);
    await ok(
      "run.reportEvents",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        events: [started(job.jobId, 1, "stream")],
      },
      actor,
    );
    const live = await ok<{ run: { id: string } }>(
      "run.live",
      { workItemId: item.workItemId },
      w.human,
    );
    const runId = live.run.id;
    const watcher = await member(w.orgId);
    expect(
      (await refusal(ok("run.takeover", { workItemId: item.workItemId, runId }, watcher))).code,
    ).toBe("forbidden");
    const watched = await ok<{ takeover: { allowed: boolean; reason: string } }>(
      "run.live",
      { workItemId: item.workItemId },
      watcher,
    );
    expect(watched.takeover.allowed).toBe(false);
    expect(watched.takeover.reason).toMatch(/runner's owner/);

    const before = delivered.length;
    const asked = await ok<{ requestId: string; status: string }>(
      "run.takeover",
      { workItemId: item.workItemId, runId },
      w.human,
    );
    expect(asked.status).toBe("queued");
    expect(delivered.slice(before).flat().length).toBeGreaterThan(0);
    const audit = await first<{ actor_id: string }>(
      "SELECT actor_id FROM core_audit WHERE operation = 'run.takeover' AND outcome = 'ok' AND work_item_id = ?",
      item.workItemId,
    );
    expect(audit?.actor_id).toBe(w.userId);
    // Once per run.
    expect(
      (await refusal(ok("run.takeover", { workItemId: item.workItemId, runId }, w.human))).code,
    ).toBe("conflict");

    type Taken = { steers: { id: string; text: string; kind: string }[] };
    const taken = await ok<Taken>(
      "run.takeSteers",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken },
      actor,
    );
    expect(taken.steers).toEqual([
      expect.objectContaining({ id: asked.requestId, text: "", kind: "takeover" }),
    ]);
    const view = await ok<{
      steers: { kind: string; status: string }[];
      takeover: { allowed: boolean; requested: boolean };
    }>("run.live", { workItemId: item.workItemId }, w.human);
    expect(view.steers).toEqual([
      expect.objectContaining({ kind: "takeover", status: "delivered" }),
    ]);
    expect(view.takeover).toMatchObject({ allowed: false, requested: true });
  });

  it("refuses a takeover for a terminal run, a runner without chat and an ended run", async () => {
    const tmux = await running(["hooks", "steer", "chat"]);
    await ok(
      "run.reportEvents",
      {
        jobId: tmux.job.jobId,
        fencingToken: tmux.job.lease.fencingToken,
        events: [started(tmux.job.jobId, 1)],
      },
      tmux.actor,
    );
    const tmuxLive = await ok<{ run: { id: string; mode: string } }>(
      "run.live",
      { workItemId: tmux.item.workItemId },
      tmux.w.human,
    );
    expect(tmuxLive.run.mode).toBe("terminal");
    expect(
      (
        await refusal(
          ok(
            "run.takeover",
            { workItemId: tmux.item.workItemId, runId: tmuxLive.run.id },
            tmux.w.human,
          ),
        )
      ).code,
    ).toBe("unavailable");

    const noChat = await running(["hooks", "steer"]);
    await ok(
      "run.reportEvents",
      {
        jobId: noChat.job.jobId,
        fencingToken: noChat.job.lease.fencingToken,
        events: [started(noChat.job.jobId, 1, "stream")],
      },
      noChat.actor,
    );
    const noChatLive = await ok<{ run: { id: string } }>(
      "run.live",
      { workItemId: noChat.item.workItemId },
      noChat.w.human,
    );
    expect(
      (
        await refusal(
          ok(
            "run.takeover",
            { workItemId: noChat.item.workItemId, runId: noChatLive.run.id },
            noChat.w.human,
          ),
        )
      ).code,
    ).toBe("unavailable");

    await ok(
      "run.release",
      {
        jobId: noChat.job.jobId,
        fencingToken: noChat.job.lease.fencingToken,
        finalState: "failed",
      },
      noChat.actor,
    );
    expect(
      (
        await refusal(
          ok(
            "run.takeover",
            { workItemId: noChat.item.workItemId, runId: noChatLive.run.id },
            noChat.w.human,
          ),
        )
      ).code,
    ).toBe("conflict");
  });
});
