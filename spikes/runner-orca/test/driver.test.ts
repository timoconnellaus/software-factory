import { describe, expect, it } from "vitest";
import { runnerChannelKey } from "../src/contract/channel.ts";
import { httpControlPlane } from "../src/contract/protocol.ts";
import {
  type AdapterEvent,
  CONTRACT_VERSION,
  type Job,
  type RunnerAdapter,
} from "../src/contract/types.ts";
import { hostTick, runJob } from "../src/host/driver.ts";
import { createFakeCloud } from "../src/host/fake-cloud.ts";

const RUNNER = "r_testrunner";

function job(overrides: Partial<Job> = {}): Job {
  return {
    jobId: "job_1",
    workItemId: "wi_1",
    attempt: 1,
    stage: "implement",
    repo: { url: "https://github.com/acme/app.git", baseRef: "main" },
    branch: "sf/wi_1",
    harness: { id: "claude-code", prompt: "add a line to README" },
    requires: [],
    output: "diff",
    limits: { sessionTimeoutMs: 5_000 },
    lease: { leaseId: "lease_1", expiresAt: "2026-11-11T01:00:00Z" },
    ...overrides,
  };
}

function fakeAdapter(script: AdapterEvent[], opts: { failPrepare?: boolean; hang?: boolean } = {}) {
  const calls: string[] = [];
  const adapter: RunnerAdapter = {
    manifest: async () => ({
      contractVersion: CONTRACT_VERSION,
      runnerKind: "fake",
      harnesses: ["claude-code"],
      capabilities: ["headless"],
    }),
    capacity: async () => ({ max: 1, inUse: 0, accepting: true }),
    prepareWorkspace: async (j) => {
      calls.push("prepare");
      if (opts.failPrepare) throw new Error("no such repo");
      return { jobId: j.jobId, path: "/w", branch: j.branch, baseSha: "a".repeat(40) };
    },
    startSession: async (j) => {
      calls.push("start");
      return { jobId: j.jobId, sessionRef: "s1" };
    },
    events: async function* (_j, _s, signal) {
      for (const e of script) yield e;
      if (opts.hang) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
      }
    },
    collectArtifacts: async (_j, ws) => {
      calls.push("collect");
      return [
        {
          kind: "diff",
          baseSha: ws.baseSha,
          headSha: ws.baseSha,
          branch: ws.branch,
          patch: "+hello",
          stats: { files: 1, insertions: 1, deletions: 0 },
        },
      ];
    },
    release: async () => {
      calls.push("release");
    },
  };
  return { adapter, calls };
}

async function setup() {
  const cloud = createFakeCloud();
  const cp = httpControlPlane({
    baseUrl: "https://factory.example",
    runnerId: RUNNER,
    key: await runnerChannelKey(cloud.masterSecret, RUNNER),
    fetch: cloud.fetch,
  });
  return { cloud, cp };
}

describe("runner host driver", () => {
  it("claims a job over the signed channel and takes it through the lifecycle", async () => {
    const { cloud, cp } = await setup();
    cloud.queue.push(job());
    const { adapter, calls } = fakeAdapter([
      { type: "agent.status", status: "working" },
      { type: "log", stream: "terminal", text: "editing README" },
      { type: "session.ended", outcome: "completed", summary: "added the line" },
    ]);
    const result = await hostTick(adapter, cp, { running: new Map() });

    expect(result?.outcome).toBe("completed");
    expect(calls).toEqual(["prepare", "start", "collect", "release"]);
    const events = cloud.events.get("job_1") ?? [];
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const states = events.flatMap((e) => (e.type === "job.state" ? [e.state] : []));
    expect(states).toEqual([
      "claimed",
      "preparing",
      "preparing",
      "running",
      "collecting",
      "handed_back",
      "released",
    ]);
    expect(cloud.handbacks.get("job_1")).toMatchObject({ outcome: "completed", branch: "sf/wi_1" });
    expect([...cloud.artifacts.values()].map((a) => a.kind).sort()).toEqual(["diff", "summary"]);
    expect(cloud.released.has("job_1")).toBe(true);
    expect(cloud.heartbeats[0]?.manifest.runnerKind).toBe("fake");
  });

  it("refuses a job whose capabilities the runner lacks, and still hands back and releases", async () => {
    const { cloud, cp } = await setup();
    const { adapter, calls } = fakeAdapter([]);
    const result = await runJob(adapter, job({ requires: ["browser"] }), cp);
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/missing capabilities: browser/);
    expect(calls).toEqual(["release"]);
    expect(cloud.handbacks.get("job_1")?.outcome).toBe("failed");
  });

  it("releases after a failed prepare", async () => {
    const { cp } = await setup();
    const { adapter, calls } = fakeAdapter([], { failPrepare: true });
    const result = await runJob(adapter, job(), cp);
    expect(result).toMatchObject({ outcome: "failed", error: "no such repo" });
    expect(calls).toEqual(["prepare", "release"]);
  });

  it("times out a session that never ends and still collects the partial diff", async () => {
    const { cp } = await setup();
    const { adapter, calls } = fakeAdapter([{ type: "agent.status", status: "working" }], {
      hang: true,
    });
    const result = await runJob(adapter, job({ limits: { sessionTimeoutMs: 50 } }), cp);
    expect(result.outcome).toBe("timed_out");
    expect(calls).toEqual(["prepare", "start", "collect", "release"]);
  });

  it("does nothing when the cloud has no job, and passes cancel commands through", async () => {
    const { cloud, cp } = await setup();
    const controller = new AbortController();
    cloud.commands.push({ kind: "cancel", jobId: "job_9", reason: "stopped from the dashboard" });
    const { adapter } = fakeAdapter([]);
    const result = await hostTick(adapter, cp, { running: new Map([["job_9", controller]]) });
    expect(result).toBeNull();
    expect(controller.signal.aborted).toBe(true);
  });

  it("re-sending the same claim returns the same job (idempotent claim)", async () => {
    const { cloud, cp } = await setup();
    cloud.queue.push(job(), job({ jobId: "job_2" }));
    const manifest = await fakeAdapter([]).adapter.manifest();
    const capacity = { max: 1, inUse: 0, accepting: true };
    const a = await cp.claim({ claimId: "c-0000001", capacity, manifest });
    const b = await cp.claim({ claimId: "c-0000001", capacity, manifest });
    expect(a.job?.jobId).toBe("job_1");
    expect(b.job?.jobId).toBe("job_1");
    expect(cloud.queue.map((j) => j.jobId)).toEqual(["job_2"]);
  });
});
