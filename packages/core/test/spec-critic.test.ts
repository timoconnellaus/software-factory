// Spec 23 part C: the spec critic's notes are recorded on the plan version, shown in the view, and
// delivered to the planner as news. They are notes only: recording them decides nothing.
import {
  type CapabilityManifest,
  CONTRACT_VERSION,
  type Job,
  type PlanningNews,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import { newItem, ok, RUNNER_ACTOR, refusal, uid, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};

describe("the spec critic's notes (spec 23 part C)", () => {
  it("records them on the plan version, shows them, and gives them to the planner as news", async () => {
    const w = await world();
    const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
    const m5 = RUNNER_ACTOR(r.runnerId);
    const item = await newItem(w, "Add CSV export");
    await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
    await ok("planning.start", { workItemId: item.workItemId }, FOREMAN);
    const { job } = await ok<{ job: Job | null }>(
      "job.claim",
      {
        claimId: uid("claim-"),
        manifest,
        capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
      },
      m5,
    );
    if (!job) throw new Error("expected the planning job");
    const agent = <O = Record<string, unknown>>(op: string, input: Record<string, unknown> = {}) =>
      ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, m5);
    const { specId } = await agent<{ specId: string }>("spec.revise", {
      specMd: "# Export\n\n- Members see Export",
      acceptanceCriteria: ["Members see Export"],
    });
    await ok(
      "spec.critique",
      {
        workItemId: item.workItemId,
        specId,
        status: "done",
        notes: ["Approve the spec.", "Who may export isn't said."],
        summary: "approve the spec",
      },
      FOREMAN,
    );
    const view = await ok<{ spec: { critique: { status: string; notes: string[] } | null } }>(
      "planning.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.spec.critique).toMatchObject({
      status: "done",
      notes: ["Approve the spec.", "Who may export isn't said."],
    });
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toContainEqual(
      expect.objectContaining({
        type: "spec.critiqued",
        specId,
        notes: ["Approve the spec.", "Who may export isn't said."],
      }),
    );
    // A version of another item is refused.
    const other = await newItem(w, "Other");
    expect(
      (
        await refusal(
          ok(
            "spec.critique",
            { workItemId: other.workItemId, specId, status: "done", notes: [], summary: null },
            FOREMAN,
          ),
        )
      ).code,
    ).toBe("not_found");
  });
});
