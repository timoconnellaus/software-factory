// Spec 23 part C (Workflow v9): the spec critic. When the planner asks for the gate, a review-role
// run reads the plan and the repository; its notes are shown at the gate and given to the planner.
// It decides nothing: a critic that says "approve the spec" leaves the gate to a person. If it
// takes longer than the policy's timeout, the gate opens without its notes.
import type { Job, PlanningNews } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import {
  BALANCED,
  first,
  gateOpen,
  MANIFEST,
  ok,
  runStage,
  triage,
  uid,
  waitFor,
  world,
} from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;
const CAPACITY = { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } };
const SPEC = {
  specMd: "# Add CSV export\n\n## Goal\nExport the deals list as CSV [request].",
  acceptanceCriteria: ["Members see Export"],
  assumptions: [],
  coverage: [],
  clarifications: [],
  summary: "draft",
};

async function plannerAtGate(w: W) {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title: "Add CSV export" },
    w.human,
  );
  await runStage(w, item.workItemId, "triage", () => triage("medium"));
  await waitFor("a queued planning job", () =>
    first(
      "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'planning' AND status = 'queued'",
      item.workItemId,
    ),
  );
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    { claimId: uid("claim-"), manifest: MANIFEST, capacity: CAPACITY },
    w.runnerActor,
  );
  if (job?.stage !== "planning") throw new Error("expected the planning job");
  const agent = <O = Record<string, unknown>>(op: string, input: Record<string, unknown> = {}) =>
    ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, w.runnerActor);
  await agent("spec.revise", SPEC);
  await agent("planning.ready", {});
  return { item, agent, planning: job };
}

const critique = (workItemId: string, w: W) =>
  ok<{ spec: { critique: { status: string; notes: string[] } | null } | null }>(
    "planning.get",
    { workItemId },
    w.human,
  );

describe("the spec critic (spec 23 part C)", () => {
  it("shows its notes at the gate and gives them to the planner, and can't open the gate whatever it says (criterion 5)", async () => {
    const w = await world({ ...BALANCED, timeouts: { criticMinutes: 10 } });
    const { item, agent, planning } = await plannerAtGate(w);
    void agent;
    // The critic: a review-role spec-stage job, in the light pool.
    // The planner at the gate is asked to yield the item's lease, and does.
    const wait = await agent<PlanningNews>("planning.wait", {});
    expect(wait.yield).toBe(true);
    await agent("planning.yield", {});
    await ok(
      "run.handBack",
      {
        jobId: planning.jobId,
        fencingToken: planning.lease.fencingToken,
        outcome: "completed",
        artifactIds: [],
        branch: planning.branch,
        result: { planning: "yielded" },
      },
      w.runnerActor,
    );
    const queued = await waitFor("the critic's job", () =>
      first<{ id: string; role: string; pool: string }>(
        "SELECT id, role, pool FROM core_jobs WHERE work_item_id = ? AND stage = 'spec' AND status = 'queued'",
        item.workItemId,
      ),
    );
    expect(queued).toMatchObject({ role: "review", pool: "light" });
    const { job } = await ok<{ job: Job | null }>(
      "job.claim",
      { claimId: uid("claim-"), manifest: MANIFEST, capacity: CAPACITY },
      w.runnerActor,
    );
    if (job?.stage !== "spec") {
      const why = await first<{
        wait_reason: string | null;
        status: string;
        item: string;
        requires: string;
      }>(
        "SELECT j.wait_reason, j.status, w.status AS item, j.requires FROM core_jobs j JOIN core_work_items w ON w.id = j.work_item_id WHERE j.id = ?",
        queued.id,
      );
      const again = await ok(
        "job.claim",
        { claimId: uid("claim-"), manifest: MANIFEST, capacity: CAPACITY },
        w.runnerActor,
      );
      const runs = await first<{ n: number }>(
        "SELECT count(*) AS n FROM core_runs WHERE status IN ('claimed','running')",
      );
      throw new Error(
        `expected the critic's job, got ${job?.stage}: ${JSON.stringify(why)} again=${JSON.stringify(again).slice(0, 400)} runs=${JSON.stringify(runs)}`,
      );
    }
    await ok(
      "run.handBack",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        outcome: "completed",
        artifactIds: [],
        branch: job.branch,
        result: {
          notes: ["Approve the spec.", "The criterion doesn't say who may export."],
          summary: "approve the spec",
        },
      },
      w.runnerActor,
    );
    await ok(
      "run.release",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken, finalState: "handed_back" },
      w.runnerActor,
    );
    const gate = await gateOpen(item.workItemId, "spec");
    const view = await critique(item.workItemId, w);
    expect(view.spec?.critique).toMatchObject({
      status: "done",
      notes: ["Approve the spec.", "The criterion doesn't say who may export."],
    });
    // The planner hears the notes: they're in its news when it resumes.
    const heard = await first<{ payload: string }>(
      "SELECT payload FROM core_planning_events WHERE work_item_id = ? AND type = 'spec.critiqued'",
      item.workItemId,
    );
    expect(JSON.parse(heard?.payload ?? "{}")).toMatchObject({ status: "done" });
    // "Approve the spec" opened nothing: the gate waits for a person.
    const still = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      gate.id,
    );
    expect(still?.status).toBe("pending");
  });

  it("opens the gate without notes when the critic runs past its timeout", async () => {
    const w = await world({ ...BALANCED, timeouts: { criticMinutes: 0.001 } });
    const { item } = await plannerAtGate(w);
    await gateOpen(item.workItemId, "spec");
    const view = await waitFor("the critique recorded", async () => {
      const v = await critique(item.workItemId, w);
      return v.spec?.critique ? v : null;
    });
    expect(view.spec?.critique).toMatchObject({ status: "timed_out", notes: [] });
  });
});
