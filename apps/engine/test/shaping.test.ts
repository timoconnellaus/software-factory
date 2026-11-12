// Shaping stages run before release (spec 50 part C, ADR 0493): a shaped item's Workflow runs
// triage (and planning when the size needs it) while the item is unreleased and not active, waits
// at `release: wait`, and goes on to delivery when it is released and pulled.
import { env } from "cloudflare:workers";
import { SOFTWARE } from "@software-factory/core/stages";
import type { Job } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { pullQueuedWork } from "../src/pull.ts";
import { definitionFor, expectPhasesAsDefined, expectStagesAsDefined } from "./definition.ts";
import {
  BALANCED,
  build,
  first,
  gateOpen,
  itemStatus,
  MANIFEST,
  ok,
  runStage,
  triage,
  uid,
  waitFor,
  world,
} from "./helpers.ts";

const statusOf = async (id: string) =>
  (await first<{ status: string }>("SELECT status FROM core_work_items WHERE id = ?", id))?.status;

describe("shaping before release (ADR 0493)", () => {
  it("shapes without a slot, waits ready, then delivers once released and there is room", async () => {
    const w = await world({ ...BALANCED, activeLimit: 1 });
    // One item already in delivery holds the only slot (no Workflow of its own, so no jobs).
    const busy = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Busy" },
      w.human,
    );
    await env.DB.prepare("UPDATE core_work_items SET status = 'running' WHERE id = ?")
      .bind(busy.workItemId)
      .run();

    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Shape me" },
      w.human,
    );
    const shaped = await ok<{ status: string }>(
      "workItem.shape",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(shaped.status).toBe("shaping");
    // Shaping runs although the project is at its active limit: it isn't delivery.
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await itemStatus(item.workItemId, "ready");
    const row = await first<{ stage: string; pulled_at: string | null }>(
      "SELECT stage, pulled_at FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row).toMatchObject({ pulled_at: null });

    // Released while the slot is taken: it waits, queued, with no build job.
    await ok("workItem.release", { workItemId: item.workItemId }, w.human);
    expect(await statusOf(item.workItemId)).toBe("queued");
    expect(
      await first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
        item.workItemId,
      ),
    ).toBeNull();

    // The slot frees: the pull wakes the shaped Workflow, which goes straight to build.
    await env.DB.prepare("UPDATE core_work_items SET status = 'done' WHERE id = ?")
      .bind(busy.workItemId)
      .run();
    await pullQueuedWork(env);
    await waitFor("the shaped item running", async () =>
      (await statusOf(item.workItemId)) === "running" ? true : null,
    );
    await runStage(w, item.workItemId, "build", () => build());
    // Triage ran once, before release.
    const triages = await first<{ n: number }>(
      "SELECT count(*) AS n FROM core_jobs WHERE work_item_id = ? AND stage = 'triage'",
      item.workItemId,
    );
    expect(triages?.n).toBe(1);
  });

  it("refuses shaping twice, and moving a shaped item back to the backlog", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Once" },
      w.human,
    );
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await itemStatus(item.workItemId, "ready");
    const again = await ok("workItem.shape", { workItemId: item.workItemId }, w.human).catch(
      (e: Error) => e,
    );
    expect(String(again)).toMatch(/already being shaped/);
    const back = await ok(
      "workItem.move",
      { workItemId: item.workItemId, to: "backlog" },
      w.human,
    ).catch((e: Error) => e);
    expect(String(back)).toMatch(/was shaped/);
  });

  it("shapes a medium item through interview planning and the spec gate, then delivers it on release", async () => {
    const policy = { ...BALANCED, workflow: "Ship", workflows: [{ name: "Ship", slots: {} }] };
    const w = await world(policy);
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Add CSV export" },
      w.human,
    );
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    // Triage runs and can't override the project's workflow while shaping (ADR 0492).
    await runStage(w, item.workItemId, "triage", () => triage("medium", { workflow: "Other" }));
    const during = await ok<{ item: { workflow: string | null; status: string } }>(
      "workItem.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(during.item).toMatchObject({ workflow: "Ship", status: "shaping" });

    // Interview planning, before release, on the light pool.
    await waitFor("a queued planning job", () =>
      first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'planning' AND status = 'queued'",
        item.workItemId,
      ),
    );
    const { job } = await ok<{ job: Job | null }>(
      "job.claim",
      {
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
      },
      w.runnerActor,
    );
    if (job?.stage !== "planning") throw new Error(`expected the planning job, got ${job?.stage}`);
    const agent = (op: string, input: Record<string, unknown> = {}) =>
      ok(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, w.runnerActor);
    await agent("spec.revise", {
      specMd: "# Add CSV export\n\n## Goal\nExport the deals list [request].",
      acceptanceCriteria: ["Members see Export"],
      assumptions: [],
      coverage: [{ category: "scope", status: "clear" }],
      clarifications: [],
      summary: "draft",
    });
    await agent("planning.ready", {});
    await gateOpen(item.workItemId, "spec");
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);

    // Shaped: ready, a plan, no build yet; a shaped plan can't be edited.
    await itemStatus(item.workItemId, "ready");
    expect(
      await first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
        item.workItemId,
      ),
    ).toBeNull();
    const edit = await ok(
      "workItem.update",
      { workItemId: item.workItemId, title: "Something else" },
      w.human,
    ).catch((e: Error) => e);
    expect(String(edit)).toMatch(/plan is fixed/);

    const released = await ok<{ plan?: { shapedAt: string | null } }>(
      "workItem.release",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(released.plan?.shapedAt).toBeTruthy();
    const built = await runStage(w, item.workItemId, "build", (b) => {
      expect(b.harness.prompt).toContain("Members see Export");
      return build();
    });
    expect(built.stage).toBe("build");
    // The compiled definition (spec 52 PR (a)): spec runs for a medium item, and exactly its
    // shaping stages ran before release.
    const { def } = definitionFor(policy, "change");
    // The test stops once build has run: the stages up to build, exactly.
    await expectStagesAsDefined(item.workItemId, def, "medium", { until: "build" });
    await expectPhasesAsDefined(item.workItemId, def, "medium");
    expect(
      await first<{ n: number }>(
        "SELECT count(*) AS n FROM core_jobs WHERE work_item_id = ? AND stage = 'triage'",
        item.workItemId,
      ),
    ).toEqual({ n: 1 });
  }, 60_000);

  it("cancels a shaped item that waits for its release, and stops its Workflow", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Waits" },
      w.human,
    );
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await itemStatus(item.workItemId, "ready");
    await ok("workItem.cancel", { workItemId: item.workItemId, reason: "not now" }, w.human);
    expect(await statusOf(item.workItemId)).toBe("cancelled");
    // A release event for it now finds no Workflow to wake, and changes nothing.
    await ok("workItem.release", { workItemId: item.workItemId }, w.human).catch(() => null);
    expect(await statusOf(item.workItemId)).toBe("cancelled");
  });

  it("fails a released item whose shaping Workflow had ended, instead of holding a slot", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Orphan" },
      w.human,
    );
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await itemStatus(item.workItemId, "ready");
    // Its Workflow dies while it waits (an error, an operator's terminate).
    const instance = await env.WORK_ITEM_WORKFLOW.get(item.workItemId);
    await instance.terminate();
    await waitFor("the instance terminated", async () =>
      (await instance.status()).status === "terminated" ? true : null,
    );
    await ok("workItem.release", { workItemId: item.workItemId }, w.human);
    await itemStatus(item.workItemId, "failed");
    const row = await first<{ status_reason: string }>(
      "SELECT status_reason FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row?.status_reason).toMatch(/shaping Workflow had terminated/);
  });
});

describe("a shaped item whose workflow's shaping changed (spec 52, Q4)", () => {
  it("is flagged at release; shaped again, a new Workflow instance shapes it under the current version", async () => {
    const w = await world({ ...BALANCED, workflow: "wf_ship" });
    const ship = (requiredFrom: string) => ({
      ...SOFTWARE,
      id: "wf_ship",
      name: "Ship",
      stages: SOFTWARE.stages.map((s) =>
        s.id === "spec" ? { ...s, settings: { requiredFrom } } : s,
      ),
    });
    await ok(
      "workflow.save",
      { orgId: w.orgId, baseVersion: 0, workflow: ship("medium") },
      w.human,
    );
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Reshape me" },
      w.human,
    );
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await itemStatus(item.workItemId, "ready");

    // The org now wants a spec from small: the shaping stages changed. Release flags it.
    await ok("workflow.save", { orgId: w.orgId, baseVersion: 1, workflow: ship("small") }, w.human);
    const flagged = await ok<{ status: string; releaseFlag?: unknown }>(
      "workItem.release",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(flagged).toMatchObject({ status: "ready", releaseFlag: expect.any(Object) });

    // Shape it again: a new instance runs the current workflow's shaping stages.
    const again = await ok<{ status: string }>(
      "workItem.releaseChoice",
      { workItemId: item.workItemId, choice: "reshape" },
      w.human,
    );
    expect(again.status).toBe("shaping");
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    // Under the current version a small item now needs a spec: its shaping goes on to planning,
    // which it skipped the first time.
    await waitFor("a planning job for the reshaped item", () =>
      first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'planning'",
        item.workItemId,
      ),
    );
    const row = await first<{ workflow_id: string; status: string; org_config_version: number }>(
      "SELECT workflow_id, status, org_config_version FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row).toMatchObject({ status: "shaping", org_config_version: 2 });
    expect(row?.workflow_id).not.toBe(item.workItemId);
  });
});
