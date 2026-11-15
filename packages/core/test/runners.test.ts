// Runners (ADR 0016, 0360, 0520, 0590): registration, the heartbeat's answer, and what a claim
// records now that the jobs are the new core's.
import type { CapabilityManifest } from "@software-factory/runner-contract";
import { CONTRACT_VERSION, RUNNER_COMPAT } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { invoke } from "../src/index.ts";
import { deps, first, ok, RUNNER_ACTOR, rows, services, uid, world } from "./helpers.ts";

const manifest = (
  capabilities: CapabilityManifest["capabilities"] = ["hooks"],
): CapabilityManifest => ({
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities,
});
const capacity = (max = 2, inUse = 0) => ({ max, inUse, accepting: true });

async function setup() {
  const w = await world();
  const runner = await ok<{ runnerId: string; key: string }>(
    "runner.register",
    { name: "M5" },
    w.human,
  );
  return { w, runner, actor: RUNNER_ACTOR(runner.runnerId) };
}

/** A claim as the channel makes it: unstored, with its signed time. */
const claim = (runnerId: string, signedAt: number, c = capacity()) =>
  invoke<{ job: null }>(
    deps,
    "runner.claim",
    { claimId: uid("claim-"), manifest: manifest(), capacity: c },
    { actor: RUNNER_ACTOR(runnerId), origin: { surface: "runner-channel", signedAt } },
  );

describe("runners", () => {
  it("registers a runner and never writes its key to the audit journal", async () => {
    const { runner, w } = await setup();
    expect(runner.key).toBe(`test-key:${runner.runnerId}:v1`);
    const audit = await first<{ result: string }>(
      "SELECT result FROM core_audit WHERE operation = 'runner.register' AND actor_id = ?",
      w.userId,
    );
    expect(audit.result).not.toContain(runner.key);
  });

  it("cancels any held job that isn't a flow job: the old core's jobs are gone", async () => {
    const { actor } = await setup();
    const beat = await ok<{ commands: { kind: string; jobId?: string }[]; leases: unknown[] }>(
      "runner.heartbeat",
      {
        manifest: manifest(),
        capacity: capacity(),
        activeJobs: [{ jobId: "job_old", fencingToken: 3 }],
      },
      actor,
    );
    expect(beat.commands).toEqual([
      { kind: "cancel", jobId: "job_old", reason: "not assigned to this runner" },
    ]);
    expect(beat.leases).toEqual([]);
  });

  it("a claim answers no job and records what it reports, unless it is a replay", async () => {
    const { runner } = await setup();
    const now = Math.floor(Date.now() / 1000);
    expect((await claim(runner.runnerId, now, capacity(3))).output.job).toBeNull();
    const after = await first<{ capacity_max: number; last_signed_at: number }>(
      "SELECT capacity_max, last_signed_at FROM core_runners WHERE id = ?",
      runner.runnerId,
    );
    expect(after).toEqual({ capacity_max: 3, last_signed_at: now });
    // Signed before the last one: a replay changes nothing.
    await claim(runner.runnerId, now - 10, capacity(5));
    expect(
      (
        await first<{ capacity_max: number }>(
          "SELECT capacity_max FROM core_runners WHERE id = ?",
          runner.runnerId,
        )
      ).capacity_max,
    ).toBe(3);
    // An empty claim that changed nothing writes no audit row (ADR 0590).
    const before = await rows(
      "SELECT 1 FROM core_audit WHERE operation = 'runner.claim' AND actor_id = ?",
      runner.runnerId,
    );
    await claim(runner.runnerId, now + 1, capacity(3));
    const later = await rows(
      "SELECT 1 FROM core_audit WHERE operation = 'runner.claim' AND actor_id = ?",
      runner.runnerId,
    );
    expect(later.length).toBe(before.length);
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

  it("answers the last runner-relevant commit when the deploy set one, and its RUNNER_COMPAT (ADR 0520)", async () => {
    const { w, runner, actor } = await setup();
    services.deployedSha = sha("c");
    services.runnerSha = sha("b");
    try {
      const beat = await ok<{ desiredVersion: string | null; minRunnerCompat: number }>(
        "runner.heartbeat",
        {
          manifest: manifest(),
          capacity: capacity(),
          activeJobs: [],
          // A runner on the deployed commit, ahead of the runner commit, reports itself current.
          version: { ...version(sha("c")), compat: RUNNER_COMPAT },
        },
        actor,
      );
      expect(beat).toMatchObject({ desiredVersion: sha("b"), minRunnerCompat: RUNNER_COMPAT });
      const listed = await ok<{
        runners: { id: string; version: string | null; desiredVersion: string | null }[];
      }>("runner.list", {}, w.human);
      expect(listed.runners.find((r) => r.id === runner.runnerId)).toMatchObject({
        version: sha("c"),
        desiredVersion: sha("b"),
      });
      // Malformed: falls back to the deployed commit.
      services.runnerSha = "nope";
      const again = await ok<{ desiredVersion: string | null }>(
        "runner.heartbeat",
        { manifest: manifest(), capacity: capacity(), activeJobs: [] },
        actor,
      );
      expect(again.desiredVersion).toBe(sha("c"));
    } finally {
      delete services.deployedSha;
      delete services.runnerSha;
    }
  });
});
