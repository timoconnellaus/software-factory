// Spec 43 (ADR 0532): a pool the runner paused for its load gets nothing new, and the inbox says why.
import type { CapabilityManifest, CapacityPaused, Job } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { type Actor, FOREMAN } from "../src/index.ts";
import { newItem, ok, RUNNER_ACTOR, uid, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};

const claim = (actor: Actor, paused?: CapacityPaused) =>
  ok<{ job: Job | null }>(
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest,
      capacity: {
        max: 2,
        inUse: 0,
        accepting: !paused || paused.pools.length < 2,
        light: { max: 6, inUse: 0 },
        ...(paused ? { paused } : {}),
      },
    },
    actor,
  ).then((r) => r.job);

describe("a runner paused for load (ADR 0532)", () => {
  it("gets no heavy job while heavy is paused, still gets light work, and the inbox says why", async () => {
    const w = await world();
    const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
    const m5 = RUNNER_ACTOR(r.runnerId);
    const build = await newItem(w, "Build me");
    await ok("branch.ensure", { workItemId: build.workItemId }, FOREMAN);
    await ok(
      "job.enqueue",
      { workItemId: build.workItemId, stage: "build", role: "implement", prompt: "Build" },
      FOREMAN,
    );
    const heavy: CapacityPaused = { reason: "load", pools: ["heavy"], load1: 16.2, cores: 10 };
    expect(await claim(m5, heavy)).toBeNull();
    const inbox = await ok<{ runners: { id: string; paused: CapacityPaused | null }[] }>(
      "inbox.list",
      {},
      w.human,
    );
    expect(inbox.runners.find((x) => x.id === m5.id)?.paused).toEqual(heavy);

    // A planning job is light: it still goes.
    const plan = await newItem(w, "Plan me");
    await ok("branch.ensure", { workItemId: plan.workItemId }, FOREMAN);
    await ok("planning.start", { workItemId: plan.workItemId }, FOREMAN);
    expect(
      await claim(m5, { reason: "load", pools: ["heavy", "light"], load1: 25, cores: 10 }),
    ).toBeNull();
    expect((await claim(m5, heavy))?.stage).toBe("planning");

    // Load gone: the build goes, and the pause is cleared.
    expect((await claim(m5))?.stage).toBe("build");
    const after = await ok<{ runners: { id: string; paused: CapacityPaused | null }[] }>(
      "inbox.list",
      {},
      w.human,
    );
    expect(after.runners.find((x) => x.id === m5.id)?.paused).toBeNull();
  });
});
