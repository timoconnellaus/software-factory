// Workflow v16 (spec 24): a plan that splits a work item. One approval creates the children (held
// in Ready); the parent builds nothing, and its PR, the approved plan's files only, goes through
// verify and the merge gate; then the children are released, and the parent closes when the last
// of them ends. End to end against real D1 and the real Workflow.
import type { Job } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import {
  all,
  first,
  gateHead,
  gateOpen,
  github,
  itemStatus,
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

async function claimPlanning(w: W, workItemId: string): Promise<Job> {
  await waitFor("a queued planning job", () =>
    first(
      "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'planning' AND status = 'queued'",
      workItemId,
    ),
  );
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    { claimId: uid("claim-"), manifest: MANIFEST, capacity: CAPACITY },
    w.runnerActor,
  );
  if (job?.stage !== "planning") throw new Error(`expected the planning job, got ${job?.stage}`);
  return job;
}

const child = (key: string, after?: string) => ({
  key,
  title: `Export: ${key}`,
  size: "small",
  goal: `The ${key} side of the export [parent]`,
  scope: [`The ${key} [parent]`],
  acceptanceCriteria: [`The ${key} streams the CSV [parent]`],
  ...(after ? { after } : {}),
});

describe("Workflow v16: a plan splits a work item (spec 24)", () => {
  it("creates the children on approval, lands the plan's PR without a build, releases them, and closes when they end", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string; branch: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Add CSV export" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("medium"));
    const job = await claimPlanning(w, item.workItemId);
    const agent = (op: string, input: Record<string, unknown> = {}) =>
      ok(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, w.runnerActor);
    await agent("spec.revise", {
      specMd: "# Add CSV export\n\n## Goal\nExport deals as CSV [request].",
      acceptanceCriteria: ["Both parts merged [parent]"],
      children: [child("api"), child("ui", "api")],
    });
    await agent("planning.news");
    await agent("planning.ready");
    await gateOpen(item.workItemId, "spec");
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);

    // Criterion 1: exactly two children, held in Ready until the plan merges.
    const kids = () =>
      all<{ id: string; status: string }>(
        "SELECT id, status FROM core_work_items WHERE parent_work_item_id = ? ORDER BY number",
        item.workItemId,
      );
    expect((await kids()).map((k) => k.status)).toEqual(["ready", "ready"]);

    // No build: the plan's PR goes straight to the merge gate, its packet passing on the files.
    const gate = await gateOpen(item.workItemId, "merge");
    expect(gate).toBeTruthy();
    expect(
      await all(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
        item.workItemId,
      ),
    ).toEqual([]);
    const packet = await first<{ verdict: string; sections: string }>(
      "SELECT verdict, sections FROM core_review_packets WHERE work_item_id = ? ORDER BY created_at DESC",
      item.workItemId,
    );
    expect(packet?.verdict).toBe("pass");
    const changed = JSON.parse(packet?.sections ?? "{}").changed?.paths ?? [];
    for (const f of changed) expect(f.path).toMatch(/^(docs\/specs|\.kim\/plans)\//);

    await ok(
      "review.merge",
      {
        workItemId: item.workItemId,
        openedFullDiff: true,
        headSha: await gateHead(item.workItemId),
      },
      w.human,
    );
    // Released together once merged; the parent waits for them.
    await waitFor("the children released", async () =>
      (await kids()).every((k) => k.status !== "ready") ? true : null,
    );
    const pr = await first<{ pr_number: number }>(
      "SELECT pr_number FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    const state = await github.state(w.repo);
    expect(state.pulls.find((p) => p.number === pr?.pr_number)?.state).toBe("merged");
    const parent = await first<{ status: string }>(
      "SELECT status FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(["running", "waiting"]).toContain(parent?.status);

    // Criterion 4: when all its children are cancelled, the parent closes as cancelled.
    const [api, ui] = await kids();
    await ok("workItem.cancel", { workItemId: api?.id, reason: "not needed" }, w.human);
    await ok("workItem.cancel", { workItemId: ui?.id, reason: "not needed" }, w.human);
    await itemStatus(item.workItemId, "cancelled");
  }, 90_000);
});
