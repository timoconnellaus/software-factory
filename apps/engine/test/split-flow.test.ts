// Workflow v16 (spec 24): a plan that splits a work item. One approval creates the children (held
// in Ready); the parent builds nothing, and its PR, the approved plan's files only, goes through
// verify and the merge gate; then the children are released, and the parent closes when the last
// of them ends. End to end against real D1 and the real Workflow.
import { type Job, splitDigest } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import {
  all,
  BALANCED,
  build,
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
  verifyPass,
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
  size: "small" as const,
  goal: `The ${key} side of the export [parent]`,
  scope: [`The ${key} [parent]`],
  acceptanceCriteria: [`The ${key} streams the CSV [parent]`],
  ...(after ? { after } : {}),
});

const CHILDREN = [child("api"), child("ui", "api")];

/** What the plan's screen sends with its approval: the gated version and the split's digest. */
async function shown(workItemId: string) {
  const spec = await first<{ version: number }>(
    "SELECT s.version FROM core_specs s JOIN core_work_items w ON w.current_spec_id = s.id WHERE w.id = ?",
    workItemId,
  );
  return { specVersion: spec?.version ?? 0, splitDigest: await splitDigest(CHILDREN) };
}

describe("Workflow 'splits': a plan splits a work item (spec 24)", () => {
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
      children: CHILDREN,
    });
    await agent("planning.news");
    await agent("planning.ready");
    await gateOpen(item.workItemId, "spec");
    await ok(
      "spec.approve",
      { workItemId: item.workItemId, ...(await shown(item.workItemId)) },
      w.human,
    );

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

  it("with activeLimit 1: the plan merges, each child is pulled, built and merged in order, and the parent closes done (review of #171)", async () => {
    const w = await world({ ...BALANCED, activeLimit: 1 });
    const item = await ok<{ workItemId: string }>(
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
      children: CHILDREN,
    });
    await agent("planning.news");
    await agent("planning.ready");
    await gateOpen(item.workItemId, "spec");
    await ok(
      "spec.approve",
      { workItemId: item.workItemId, ...(await shown(item.workItemId)) },
      w.human,
    );
    await gateOpen(item.workItemId, "merge");
    await ok(
      "review.merge",
      {
        workItemId: item.workItemId,
        openedFullDiff: true,
        headSha: await gateHead(item.workItemId),
      },
      w.human,
    );
    const kids = await waitFor("the children released", async () => {
      const rows = await all<{ id: string; status: string }>(
        "SELECT id, status FROM core_work_items WHERE parent_work_item_id = ? ORDER BY number",
        item.workItemId,
      );
      return rows.every((k) => k.status !== "ready") ? rows : null;
    });
    // The parent holds no slot: the first child is pulled under activeLimit 1.
    for (const kid of kids) {
      await runStage(w, kid.id, "triage", () => triage("small"));
      await runStage(w, kid.id, "build", () => build([`src/${kid.id}.ts`]));
      await runStage(w, kid.id, "verify", () => verifyPass);
      await gateOpen(kid.id, "merge");
      await ok(
        "review.merge",
        { workItemId: kid.id, openedFullDiff: true, headSha: await gateHead(kid.id) },
        w.human,
      );
      await itemStatus(kid.id, "done");
    }
    await itemStatus(item.workItemId, "done");
  }, 120_000);
});
