import { env } from "cloudflare:workers";
import type { CapabilityManifest, Job } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN, runEvent } from "../src/index.ts";
import { protectedGuards } from "../src/testing/index.ts";
import {
  call,
  first,
  newItem,
  ok,
  POLICY,
  RUNNER_ACTOR,
  refusal,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

const manifest = (
  capabilities: CapabilityManifest["capabilities"] = ["hooks"],
): CapabilityManifest => ({
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities,
});
const capacity = (max = 2, inUse = 0) => ({ max, inUse, accepting: true });

async function setup(policy?: unknown) {
  const w = await world(policy);
  const runner = await ok<{ runnerId: string; key: string }>(
    "runner.register",
    { name: "M5" },
    w.human,
  );
  const item = await newItem(w);
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  return { w, runner, item, actor: RUNNER_ACTOR(runner.runnerId) };
}

async function enqueue(workItemId: string, stage: "triage" | "build" = "build") {
  return ok<{ jobId: string }>(
    "job.enqueue",
    { workItemId, stage, role: stage === "build" ? "implement" : "triage", prompt: "Do it" },
    FOREMAN,
  );
}

const claim = (
  actor: ReturnType<typeof RUNNER_ACTOR>,
  m = manifest(),
  c = capacity(),
  claimId = uid("claim-"),
) => ok<{ job: Job | null }>("job.claim", { claimId, manifest: m, capacity: c }, actor);

describe("runners and the scheduler", () => {
  it("shows a runner's slots in use in the inbox, and narrows to the org asked for", async () => {
    const { w, runner, item, actor } = await setup();
    await enqueue(item.workItemId);
    expect((await claim(actor)).job).not.toBeNull();
    const inbox = await ok<{ runners: { id: string; inUse: number; state: string }[] }>(
      "inbox.list",
      {},
      w.human,
    );
    expect(inbox.runners).toEqual([
      expect.objectContaining({ id: runner.runnerId, inUse: 1, state: "busy" }),
    ]);
    const elsewhere = await ok<{ running: unknown[]; gates: unknown[] }>(
      "inbox.list",
      { orgId: uid("org_") },
      w.human,
    );
    expect(elsewhere.running).toEqual([]);
    const mine = await ok<{ running: unknown[] }>("inbox.list", { orgId: w.orgId }, w.human);
    expect(mine.running.length).toBeGreaterThan(0);
  });

  it("registers a runner and never writes its key to the audit journal", async () => {
    const { runner, w } = await setup();
    expect(runner.key).toBe(`test-key:${runner.runnerId}:v1`);
    const audit = await first<{ result: string }>(
      "SELECT result FROM core_audit WHERE operation = 'runner.register' AND actor_id = ?",
      w.userId,
    );
    expect(audit.result).not.toContain(runner.key);
  });

  it("claims the oldest job it can run: run branch, lease and fencing token; the same claimId gets the same job", async () => {
    const { item, actor } = await setup();
    const { jobId } = await enqueue(item.workItemId);
    const claimId = uid("claim-");
    const got = await claim(actor, manifest(), capacity(), claimId);
    expect(got.job).toMatchObject({
      jobId,
      runNo: 1,
      stage: "build",
      branch: `${item.branch}-run-1`,
      repo: { baseRef: item.branch },
      harness: { role: "implement", model: "claude-opus-5-5" },
      lease: { fencingToken: 1 },
    });
    const again = await claim(actor, manifest(), capacity(), claimId);
    expect(again.job?.runId).toBe(got.job?.runId);
    expect((await claim(actor)).job).toBeNull();
  });

  it("gives no job to a runner at capacity, without a required capability, or rate-limited", async () => {
    const { item, actor } = await setup({
      version: 1,
      autonomyPolicy: "balanced",
      requires: { build: ["browser"] },
    });
    await enqueue(item.workItemId);
    expect((await claim(actor, manifest(["hooks"]))).job).toBeNull();
    expect((await claim(actor, manifest(["browser"]), capacity(1, 1))).job).toBeNull();
    await ok(
      "runner.heartbeat",
      {
        manifest: manifest(["browser"]),
        capacity: capacity(),
        activeJobs: [],
        rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
      },
      actor,
    );
    expect((await claim(actor, manifest(["browser"]))).job).toBeNull();
    await ok(
      "runner.heartbeat",
      {
        manifest: manifest(["browser"]),
        capacity: capacity(),
        activeJobs: [],
        rateLimitedUntil: null,
      },
      actor,
    );
    expect((await claim(actor, manifest(["browser"]))).job).not.toBeNull();
  });

  it("never gives a job to someone else's runner that isn't shared into the project", async () => {
    const { item } = await setup();
    const other = await world();
    const stranger = await ok<{ runnerId: string }>(
      "runner.register",
      { name: "theirs" },
      other.human,
    );
    await enqueue(item.workItemId);
    expect((await claim(RUNNER_ACTOR(stranger.runnerId))).job).toBeNull();
  });

  it("holds new builds when the project is at its WIP limit, with the reason 'waiting on review'", async () => {
    const { w, item, actor } = await setup({ version: 1, autonomyPolicy: "balanced", wipLimit: 1 });
    const waiting = await newItem(w, "Waiting thing");
    await call(
      "pr.merge",
      { workItemId: waiting.workItemId, headSha: "abcdef1", touchesFactoryConfig: false },
      FOREMAN,
    );
    const { jobId } = await enqueue(item.workItemId);
    expect((await claim(actor)).job).toBeNull();
    const job = await first<{ wait_reason: string }>(
      "SELECT wait_reason FROM core_jobs WHERE id = ?",
      jobId,
    );
    expect(job.wait_reason).toBe("waiting on review");
    // Triage isn't a build: it still runs.
    await enqueue(item.workItemId, "triage");
    expect((await claim(actor)).job?.stage).toBe("triage");
  });

  it("holds builds while protection is red when the policy says block (ADR 0280), and not on warn", async () => {
    const blocking = await setup({ ...POLICY, protection: { onRed: "block" } });
    await ok("protection.check", { projectId: blocking.w.projectId }, blocking.w.human);
    const { jobId } = await enqueue(blocking.item.workItemId);
    expect((await claim(blocking.actor)).job).toBeNull();
    const held = await first<{ wait_reason: string }>(
      "SELECT wait_reason FROM core_jobs WHERE id = ?",
      jobId,
    );
    expect(held.wait_reason).toBe("default-branch protection is red");
    // Fixed on GitHub: the next check is green and the build is claimed.
    await services.github.setGuards(blocking.w.repo, protectedGuards());
    await ok("protection.check", { projectId: blocking.w.projectId }, blocking.w.human);
    expect((await claim(blocking.actor)).job?.jobId).toBe(jobId);

    const warning = await setup();
    await ok("protection.check", { projectId: warning.w.projectId }, warning.w.human);
    await enqueue(warning.item.workItemId);
    expect((await claim(warning.actor)).job).not.toBeNull();
  });

  it("fences a run that was taken over: its writes are refused, the heartbeat cancels it and its slot is free", async () => {
    const { w, item, actor } = await setup();
    await enqueue(item.workItemId);
    const job = (await claim(actor)).job as Job;
    await ok(
      "run.reportEvents",
      {
        jobId: job.jobId,
        fencingToken: 1,
        events: [
          {
            jobId: job.jobId,
            seq: 0,
            at: new Date().toISOString(),
            type: "job.state",
            state: "running",
          },
        ],
      },
      actor,
    );
    const taken = await ok<{ fencingToken: number }>(
      "lease.claim",
      { workItemId: item.workItemId, holderId: "local-session", takeover: true },
      w.human,
    );
    expect(taken.fencingToken).toBe(2);
    const refused = await refusal(
      call(
        "run.handBack",
        {
          jobId: job.jobId,
          fencingToken: 1,
          outcome: "completed",
          artifactIds: [],
          branch: job.branch,
        },
        actor,
      ),
    );
    expect(refused.code).toBe("fenced");
    const beat = await ok<{ commands: { kind: string; jobId: string }[] }>(
      "runner.heartbeat",
      {
        manifest: manifest(),
        capacity: capacity(),
        activeJobs: [{ jobId: job.jobId, fencingToken: 1 }],
      },
      actor,
    );
    expect(beat.commands).toEqual([expect.objectContaining({ kind: "cancel", jobId: job.jobId })]);
    const run = await first<{ status: string }>(
      "SELECT status FROM core_runs WHERE id = ?",
      job.runId,
    );
    expect(run.status).toBe("cancelled");
    const event = await rows(
      "SELECT id FROM core_outbox WHERE payload LIKE ?",
      `%${runEvent(job.jobId)}%`,
    );
    expect(event).toHaveLength(1);
  });

  it("mints a job token for the current token only, never storing it", async () => {
    const { item, actor } = await setup();
    await enqueue(item.workItemId);
    const job = (await claim(actor)).job as Job;
    const token = await ok<{ token: string; pushBranch: string }>(
      "run.issueToken",
      { jobId: job.jobId, fencingToken: 1 },
      actor,
    );
    expect(token.token).toMatch(/^ghs_fake_/);
    expect(token.pushBranch).toBe(job.branch);
    const audit = await first<{ result: string }>(
      "SELECT result FROM core_audit WHERE operation = 'run.issueToken' AND work_item_id = ?",
      item.workItemId,
    );
    expect(audit.result).not.toContain(token.token);
    expect(
      (await refusal(call("run.issueToken", { jobId: job.jobId, fencingToken: 0 }, actor))).code,
    ).toBe("fenced");
  });

  it("accepts a build hand-back only for the run's own branch at the head pushed to GitHub, then fast-forwards the item branch", async () => {
    const { w, item, actor } = await setup();
    await enqueue(item.workItemId);
    const job = (await claim(actor)).job as Job;
    const base = await services.github.getBranchSha(w.repo, item.branch);
    const head = await services.github.push(w.repo, job.branch, base ?? undefined);

    const wrong = await ok<{ accepted: boolean; reason: string }>(
      "run.handBack",
      {
        jobId: job.jobId,
        fencingToken: 1,
        outcome: "completed",
        artifactIds: [],
        branch: "main",
        headSha: head,
      },
      actor,
    );
    expect(wrong).toMatchObject({ accepted: false });
    expect(wrong.reason).toMatch(/may only push/);
    // The run failed: the next job is a new run with a new branch.
    await enqueue(item.workItemId);
    const retry = (await claim(actor)).job as Job;
    expect(retry.runNo).toBe(2);
    expect(retry.lease.fencingToken).toBe(2);
    const head2 = await services.github.push(w.repo, retry.branch, base ?? undefined);
    const handed = await ok<{ accepted: boolean }>(
      "run.handBack",
      {
        jobId: retry.jobId,
        fencingToken: 2,
        outcome: "completed",
        artifactIds: [],
        branch: retry.branch,
        headSha: head2,
      },
      actor,
    );
    expect(handed.accepted).toBe(true);
    const advanced = await ok<{ ok: boolean; sha: string }>(
      "branch.advance",
      { workItemId: item.workItemId, runId: retry.runId },
      FOREMAN,
    );
    expect(advanced).toMatchObject({ ok: true, sha: head2 });
    expect(await services.github.getBranchSha(w.repo, item.branch)).toBe(head2);
    await ok(
      "run.release",
      { jobId: retry.jobId, fencingToken: 2, finalState: "handed_back" },
      actor,
    );
    const lease = await first<{ holder_id: string | null; fencing_token: number }>(
      "SELECT holder_id, fencing_token FROM core_leases WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(lease).toEqual({ holder_id: null, fencing_token: 2 });
    void env;
  });

  it("expires a quiet run: bumps the token so the zombie's writes are refused", async () => {
    const { item, actor } = await setup();
    const { jobId } = await enqueue(item.workItemId);
    const job = (await claim(actor)).job as Job;
    const out = await ok<{ expired: boolean }>(
      "run.expire",
      { jobId, reason: "no hand-back in time" },
      FOREMAN,
    );
    expect(out.expired).toBe(true);
    expect(
      (
        await refusal(
          call(
            "run.reportEvents",
            { jobId, fencingToken: job.lease.fencingToken, events: [] },
            actor,
          ),
        )
      ).code,
    ).toBe("fenced");
  });

  it("previews routing with the same placement rules as the scheduler", async () => {
    const { w, runner, actor } = await setup();
    await ok(
      "runner.heartbeat",
      { manifest: manifest(), capacity: capacity(), activeJobs: [] },
      actor,
    );
    const preview = await ok<{ runner: { id: string } | null; models: { sameModel: boolean } }>(
      "workItem.previewRouting",
      { projectId: w.projectId },
      w.human,
    );
    expect(preview.runner?.id).toBe(runner.runnerId);
    expect(preview.models.sameModel).toBe(false);
  });
});

describe("runner versions (ADR 0360)", () => {
  const sha = (c: string) => c.repeat(40);
  const version = (at: string, state = "current", reason: string | null = null) => ({
    sha: at,
    autoUpdate: true,
    update: { state, target: state === "current" ? null : sha("b"), reason },
  });

  it("answers the deployed commit, and records what the runner reports for runner.list", async () => {
    const { w, runner, actor } = await setup();
    services.deployedSha = sha("b");
    try {
      const beat = await ok<{ desiredVersion: string | null }>(
        "runner.heartbeat",
        {
          manifest: manifest(),
          capacity: capacity(),
          activeJobs: [],
          version: version(sha("a"), "blocked", "the checkout has local changes"),
        },
        actor,
      );
      expect(beat.desiredVersion).toBe(sha("b"));
      const listed = await ok<{
        runners: {
          id: string;
          version: string | null;
          desiredVersion: string | null;
          autoUpdate: boolean | null;
          update: { state: string; reason: string | null } | null;
        }[];
      }>("runner.list", {}, w.human);
      expect(listed.runners.find((r) => r.id === runner.runnerId)).toMatchObject({
        version: sha("a"),
        desiredVersion: sha("b"),
        autoUpdate: true,
        update: { state: "blocked", reason: "the checkout has local changes" },
      });
    } finally {
      delete services.deployedSha;
    }
  });

  it("answers null on an engine that doesn't know its commit, and accepts an older runner's heartbeat", async () => {
    const { w, runner, actor } = await setup();
    services.deployedSha = "not-a-sha";
    try {
      const beat = await ok<{ desiredVersion: string | null }>(
        "runner.heartbeat",
        { manifest: manifest(), capacity: capacity(), activeJobs: [] },
        actor,
      );
      expect(beat.desiredVersion).toBeNull();
      const listed = await ok<{ runners: { id: string; version: string | null }[] }>(
        "runner.list",
        {},
        w.human,
      );
      expect(listed.runners.find((r) => r.id === runner.runnerId)?.version).toBeNull();
    } finally {
      delete services.deployedSha;
    }
  });
});
