// The gate after a babysitter resolution (spec 53 decision 1; #201 reviews): the one rule both the
// engine and the desktop use, branch.advance's own marker, a commit on top of a resolution, and
// babysit.resolution recording only the item's head.
import { env } from "cloudflare:workers";
import type { CapabilityManifest, Job } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { BABYSITTER, FOREMAN } from "../src/index.ts";
import { fullDiffNeeded } from "../src/verify/resolution-rule.ts";
import { RESOLUTION_RULE_CASES } from "./fixtures/resolution-rule-cases.ts";
import { newItem, ok, RUNNER_ACTOR, refusal, services, uid, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};

describe("the full-diff rule (one table for the engine and the desktop)", () => {
  for (const c of RESOLUTION_RULE_CASES) {
    it(c.name, () => {
      expect(fullDiffNeeded(c.at) !== null).toBe(c.needs);
    });
  }
});

/** An item whose branch a babysit run advanced to `head`, through the real branch.advance. */
async function advancedByBabysit() {
  const w = await world();
  const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const actor = RUNNER_ACTOR(runner.runnerId);
  const item = await newItem(w);
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  const { jobId } = await ok<{ jobId: string }>(
    "job.enqueue",
    { workItemId: item.workItemId, stage: "build", role: "implement", prompt: "Resolve it" },
    FOREMAN,
  );
  // The babysitter's job, as far as branch.advance can tell: its stage.
  await env.DB.prepare("UPDATE core_jobs SET stage = 'babysit' WHERE id = ?").bind(jobId).run();
  const { job } = await ok<{ job: Job }>(
    "job.claim",
    { claimId: uid("c"), manifest, capacity: { max: 1, inUse: 0, accepting: true } },
    actor,
  );
  const base = await services.github.getBranchSha(w.repo, item.branch);
  const head = await services.github.push(w.repo, job.branch, base ?? undefined);
  await ok(
    "run.handBack",
    {
      jobId: job.jobId,
      fencingToken: job.lease.fencingToken,
      outcome: "completed",
      artifactIds: [],
      branch: job.branch,
      headSha: head,
    },
    actor,
  );
  const advanced = await ok<{ ok: boolean }>(
    "branch.advance",
    { workItemId: item.workItemId, runId: job.runId },
    FOREMAN,
  );
  expect(advanced.ok).toBe(true);
  return { w, item, head };
}

const get = (w: Awaited<ReturnType<typeof world>>, workItemId: string) =>
  ok<{
    babysitResolution: unknown;
    resolutionExpected?: boolean;
    resolvedHead?: string | null;
  }>("workItem.get", { workItemId }, w.human);

describe("the gate after a babysitter resolution", () => {
  it("knows a babysit run's head from branch.advance's own marker, before babysit.resolution writes", async () => {
    const { w, item, head } = await advancedByBabysit();
    const row = await env.DB.prepare(
      "SELECT head_sha, summary FROM core_babysit_resolutions WHERE work_item_id = ?",
    )
      .bind(item.workItemId)
      .first<{ head_sha: string; summary: string }>();
    expect(row).toEqual({ head_sha: head, summary: JSON.stringify({ pending: true }) });
    expect(await get(w, item.workItemId)).toMatchObject({
      babysitResolution: null,
      resolutionExpected: true,
      resolvedHead: null,
    });
  });

  it("still needs the full diff for a commit on top of the resolution, until a person approves a merge", async () => {
    const { w, item, head } = await advancedByBabysit();
    // Someone pushes on top of the resolved head; the item records it.
    const later = await services.github.push(w.repo, item.branch, head);
    await env.DB.prepare("UPDATE core_work_items SET head_sha = ? WHERE id = ?")
      .bind(later, item.workItemId)
      .run();
    expect(await get(w, item.workItemId)).toMatchObject({
      babysitResolution: null,
      resolutionExpected: true,
      resolvedHead: head,
    });
    // A person approved a merge since the resolution: an ordinary gate again.
    await env.DB.prepare(
      "INSERT INTO core_pending_actions (id, project_id, work_item_id, kind, operation, risk, actor_type, actor_id, input, status, decision, decided_at, decided_by, created_at) SELECT ?, project_id, id, 'merge', 'pr.merge', 'merge', 'agent', 'foreman', '{}', 'approved', 'approved', ?, ?, ? FROM core_work_items WHERE id = ?",
    )
      .bind(
        uid("pa"),
        new Date(Date.now() + 1000).toISOString(),
        w.human.id,
        new Date().toISOString(),
        item.workItemId,
      )
      .run();
    expect(await get(w, item.workItemId)).toMatchObject({
      resolutionExpected: false,
      resolvedHead: null,
    });
  });

  it("babysit.resolution records only the item's current head", async () => {
    const { item } = await advancedByBabysit();
    // A current fence, so only the head can refuse it.
    await env.DB.prepare(
      "INSERT INTO core_delivery_state (key, project_id, repository_id, updated_at, babysit_fence) SELECT project_id || ':' || repository_id, project_id, repository_id, ?, 1 FROM core_work_items WHERE id = ? ON CONFLICT (key) DO UPDATE SET babysit_fence = 1",
    )
      .bind(new Date().toISOString(), item.workItemId)
      .run();
    const e = await refusal(
      ok(
        "babysit.resolution",
        {
          workItemId: item.workItemId,
          headSha: "f".repeat(40),
          approvedHead: "e".repeat(40),
          deliveryFence: 1,
        },
        BABYSITTER,
      ),
    );
    expect(e.message).toMatch(/the item's head is .*, not ffffff/);
  });
});
