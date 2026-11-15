import { describe, expect, it } from "vitest";
import {
  artifactId,
  type CapabilityManifest,
  ChannelCallError,
  CONTRACT_VERSION,
  canRun,
  flowResultSchema,
  handleRunnerCall,
  hasRepo,
  httpControlPlane,
  isFlowBranch,
  isUnstoredPath,
  jobSchema,
  memoryIdempotencyStore,
  PATHS,
  parseJobPath,
  type RepoJob,
  runnerChannelKey,
  runnerEventSchema,
} from "../src/index.ts";

const MASTER = "master-secret";
const RUNNER = "r_macmini01";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities: ["browser", "ui-takeover", "hooks"],
};

describe("contract helpers", () => {
  it("checks capabilities and harness before a runner takes a job", () => {
    expect(
      canRun(manifest, { harness: { id: "claude-code" } as never, requires: ["browser"] }),
    ).toEqual({
      ok: true,
    });
    expect(
      canRun(manifest, { harness: { id: "claude-code" } as never, requires: ["headless"] }),
    ).toMatchObject({ ok: false, reason: "missing capabilities: headless" });
  });

  it("parses job paths and marks the token call unstored", () => {
    expect(parseJobPath(PATHS.handback("job_1"))).toEqual({ jobId: "job_1", call: "handback" });
    expect(parseJobPath("/runner/v1/jobs/job_1/nope")).toBeNull();
    expect(isUnstoredPath(PATHS.token("job_1"))).toBe(true);
    expect(isUnstoredPath(PATHS.events("job_1"))).toBe(false);
    // The heartbeat and the claim are idempotent (the claim by its claimId) and too frequent to store.
    expect(isUnstoredPath(PATHS.heartbeat)).toBe(true);
    expect(isUnstoredPath(PATHS.claim)).toBe(true);
    // The old pipeline's calls are gone: an older runner's steer or attachments call is unknown.
    expect(parseJobPath("/runner/v1/jobs/job_1/steer")).toBeNull();
    expect(parseJobPath("/runner/v1/jobs/job_1/attachments")).toBeNull();
  });

  it("carries transcript messages and screen logs as events (additive, ADR 0400)", () => {
    const base = { jobId: "job_1", seq: 1, at: new Date().toISOString() };
    expect(
      runnerEventSchema.parse({ ...base, type: "message", role: "assistant", text: "Done." }),
    ).toMatchObject({ type: "message", role: "assistant" });
    expect(
      runnerEventSchema.parse({
        ...base,
        type: "log",
        stream: "terminal",
        text: "$",
        screen: true,
      }),
    ).toMatchObject({ screen: true });
    expect(() =>
      runnerEventSchema.parse({
        ...base,
        type: "message",
        role: "assistant",
        text: "x".repeat(9_000),
      }),
    ).toThrow();
  });

  it("takes a flow job with or without a repo, and no other stage", () => {
    const base = {
      jobId: "job_f",
      runId: "run_f",
      runNo: 1,
      workItem: { id: "wi_1", number: 1, title: "Write the launch post" },
      harness: { id: "claude-code", role: "implement", prompt: "write it" },
      context: {},
      requires: [],
      limits: { sessionTimeoutMs: 60_000 },
      lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    };
    const flow = jobSchema.parse({ ...base, stage: "flow" });
    expect(hasRepo(flow)).toBe(false);
    // A stage of the old pipeline is refused.
    expect(jobSchema.safeParse({ ...base, stage: "build" }).success).toBe(false);
    // MCP servers ride on the job (spec 70 milestone 2).
    const mcpServers = [
      {
        name: "factory",
        url: "https://sf-engine.example/flow/mcp",
        headers: { Authorization: "Bearer t" },
      },
    ];
    expect(jobSchema.parse({ ...base, stage: "flow", mcpServers }).mcpServers).toEqual(mcpServers);
    const withRepo = jobSchema.parse({
      ...base,
      stage: "flow",
      repo: { url: "https://github.com/o/r.git", owner: "o", name: "r", baseRef: "main" },
      branch: "factory/flow-acm-7",
    });
    expect(hasRepo(withRepo)).toBe(true);
    expect(flowResultSchema.parse({ outcome: "done", summary: "posted" })).toEqual({
      outcome: "done",
      summary: "posted",
    });
    expect(flowResultSchema.safeParse({ outcome: "maybe", summary: "x" }).success).toBe(false);
  });

  it("names a flow job's item branch one level under factory/", () => {
    expect(isFlowBranch("factory/flow-acm-7")).toBe(true);
    expect(isFlowBranch("factory/flow-my-proj-12")).toBe(true);
    expect(isFlowBranch("factory/flow-acm")).toBe(false);
    expect(isFlowBranch("factory/flow-ACM-7")).toBe(false);
    expect(isFlowBranch("factory/7-acm")).toBe(false);
  });

  it("gives an artifact a content-hash id", async () => {
    const a = await artifactId({ kind: "summary", text: "hi" });
    expect(a).toMatch(/^a_[0-9a-f]{32}$/);
    expect(await artifactId({ kind: "summary", text: "hi" })).toBe(a);
  });
});

describe("httpControlPlane against handleRunnerCall", () => {
  const store = memoryIdempotencyStore();
  const keyFor = (runner: string) => runnerChannelKey(MASTER, runner);
  const job = jobSchema.parse({
    jobId: "job_1",
    runId: "run_1",
    runNo: 1,
    stage: "flow",
    workItem: { id: "wi_1", number: 1, title: "Add dark mode" },
    repo: {
      url: "https://github.com/o/r.git",
      owner: "o",
      name: "r",
      baseRef: "main",
    },
    branch: "factory/flow-acm-1",
    harness: { id: "claude-code", role: "implement", prompt: "do it" },
    context: {},
    requires: [],
    limits: { sessionTimeoutMs: 60_000 },
    lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
  }) as RepoJob;
  const cloudFetch: typeof fetch = async (input, init) =>
    handleRunnerCall(
      new Request(input, init),
      { keyFor, store, unstoredPath: isUnstoredPath },
      async ({ path, body }) => {
        if (path === PATHS.claim) return { body: { job } };
        if (path === PATHS.handback("job_1")) {
          const { fencingToken } = body as { fencingToken: number };
          return fencingToken === 1
            ? { body: { ok: true } }
            : { status: 409, body: { error: "stale fencing token", code: "fenced" } };
        }
        return { body: { commands: [], leases: [] } };
      },
    );

  it("signs requests, verifies responses and surfaces refusal codes", async () => {
    const client = httpControlPlane({
      baseUrl: "https://engine.example",
      runnerId: RUNNER,
      key: await runnerChannelKey(MASTER, RUNNER),
      fetch: cloudFetch,
    });
    const claimed = await client.claim({
      claimId: "claim-0001",
      manifest,
      capacity: { max: 2, inUse: 0, accepting: true },
    });
    expect(claimed.job?.jobId).toBe("job_1");
    await client.handback({
      jobId: "job_1",
      fencingToken: 1,
      outcome: "completed",
      artifactIds: [],
      branch: job.branch,
    });
    const refused = await client
      .handback({
        jobId: "job_1",
        fencingToken: 0,
        outcome: "completed",
        artifactIds: [],
        branch: job.branch,
      })
      .catch((e: unknown) => e);
    // Same idempotency key (hand:job_1) with another body: the store refuses it before the handler.
    expect(refused).toBeInstanceOf(ChannelCallError);
    expect((refused as ChannelCallError).status).toBe(409);
  });
});
