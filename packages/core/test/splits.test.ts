// Spec 24: a plan splits a work item. Approving the spec creates its children (held in Ready until
// the parent's plan merges), a repeated approval creates none, a child can't split again, the
// parent's PR may carry only the approved plan's files, and the children's ends reach the parent.
import {
  type CapabilityManifest,
  CONTRACT_VERSION,
  type Job,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import { call, first, newItem, ok, RUNNER_ACTOR, refusal, rows, uid, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};
type W = Awaited<ReturnType<typeof world>>;
const SPEC = {
  specMd: "# Export\n\n## Scope\n- Members see Export",
  acceptanceCriteria: ["Members see Export"],
};

async function planning(w: W, parentId: string | null = null) {
  const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const m5 = RUNNER_ACTOR(r.runnerId);
  const item = await newItem(w, "Add CSV export");
  if (parentId) {
    await rows(
      "UPDATE core_work_items SET parent_work_item_id = ? WHERE id = ?",
      parentId,
      item.workItemId,
    );
  }
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
  return { item, agent };
}

import { splitProblem } from "@software-factory/runner-contract";
import { assemblePacket, summarizeCi } from "../src/index.ts";

const child = (key: string, after?: string) => ({
  key,
  title: `Export ${key}`,
  size: "small",
  goal: `The ${key} part of the export [parent]`,
  scope: [`The ${key} [parent]`],
  acceptanceCriteria: [`The ${key} works [parent]`],
  ...(after ? { after } : {}),
});
const SPLIT = {
  ...SPEC,
  children: [child("api"), child("ui", "api")],
};

/** A parent planned with SPLIT, at the gate, approved by a person. */
async function approvedSplit(w: W) {
  const { item, agent } = await planning(w);
  const { specId } = await agent<{ specId: string }>("spec.revise", SPLIT);
  await agent("planning.news");
  await agent("planning.ready");
  const gate = await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
  expect(gate.status).toBe("pending");
  await ok("spec.approve", { workItemId: item.workItemId }, w.human);
  return { item, agent, specId };
}
const childrenOf = (parent: string) =>
  rows<{
    id: string;
    number: number;
    status: string;
    source: string;
    body: string;
    title: string;
    acceptance_criteria: string;
    needs_info: string | null;
  }>(
    "SELECT id, number, status, source, body, title, acceptance_criteria, needs_info FROM core_work_items WHERE parent_work_item_id = ? ORDER BY number",
    parent,
  );

describe("splits (spec 24)", () => {
  it("checks a split's keys and its after chain", () => {
    const c = (key: string, after?: string) => child(key, after) as never;
    expect(splitProblem([c("a"), c("b", "a")])).toBeNull();
    expect(splitProblem([c("a"), c("a")])).toMatch(/share the key/);
    expect(splitProblem([c("a", "zz")])).toMatch(/isn't one of the children/);
    expect(splitProblem([c("a", "b"), c("b", "a")])).toMatch(/waits for itself/);
  });

  it("creates exactly the children on approval, with their slices, held in Ready (criterion 1)", async () => {
    const w = await world();
    const { item } = await approvedSplit(w);
    const kids = await childrenOf(item.workItemId);
    expect(kids).toHaveLength(2);
    for (const k of kids) {
      expect(k).toMatchObject({ status: "ready", source: "planning" });
      expect(k.body).toContain(`Part of #${item.number}`);
    }
    expect(JSON.parse(kids[0]?.acceptance_criteria ?? "[]")).toEqual(["The api works [parent]"]);
    // ui waits for api.
    expect(
      await rows(
        "SELECT waits_for_id FROM core_work_item_links WHERE work_item_id = ?",
        kids[1]?.id,
      ),
    ).toEqual([{ waits_for_id: kids[0]?.id }]);
    // A repeated approval creates none.
    const again = await call("spec.approve", { workItemId: item.workItemId }, w.human);
    expect(again.status).not.toBe("error");
    expect(await childrenOf(item.workItemId)).toHaveLength(2);
  });

  it("refuses children in a child's plan (criterion 3)", async () => {
    const w = await world();
    const parent = await newItem(w, "The parent");
    const { agent } = await planning(w, parent.workItemId);
    const refused = await refusal(agent("spec.revise", SPLIT));
    expect(refused.message).toMatch(/can't split again/);
    expect(await agent("spec.revise", SPEC)).toMatchObject({ version: 1 });
  });

  it("releases the children once the parent's plan merged, parks one whose sibling was cancelled, and tells the parent when they all ended (criteria 2, 4)", async () => {
    const w = await world();
    const { item } = await approvedSplit(w);
    await rows(
      "UPDATE core_specs SET status = 'approved' WHERE work_item_id = ? AND status = 'draft'",
      item.workItemId,
    );
    await ok("spec.commit", { workItemId: item.workItemId }, FOREMAN);
    const released = await ok<{ released: number }>(
      "split.release",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    expect(released.released).toBe(2);
    const [api, ui] = await childrenOf(item.workItemId);
    if (!api || !ui) throw new Error("expected two children");
    // ui waits for api (its link), so the pull starts api only.
    expect(["queued", "running"]).toContain(api.status);
    expect(ui.status).toBe("queued");
    // api is cancelled: ui parks with a question rather than waiting forever.
    await ok("workItem.cancel", { workItemId: api.id, reason: "not needed" }, w.human);
    const [, parkedUi] = await childrenOf(item.workItemId);
    const marker = JSON.parse(parkedUi?.needs_info ?? "{}");
    expect(marker).toMatchObject({ source: "split", missing: ["dependency"] });
    const [q] = await rows<{ id: string; options: string }>(
      "SELECT id, options FROM core_questions WHERE id = ?",
      marker.questionIds[0],
    );
    expect(JSON.parse(q?.options ?? "[]")[0]).toMatch(/^Start #\d+ without #\d+$/);
    // The owner starts it without api: the link goes and it is queued again.
    await ok(
      "question.answer",
      { questionId: q?.id, answer: JSON.parse(q?.options ?? "[]")[0] },
      w.human,
    );
    expect(await rows("SELECT * FROM core_work_item_links WHERE work_item_id = ?", ui.id)).toEqual(
      [],
    );
    const resumed = await first<{ status: string; needs_info: string | null }>(
      "SELECT status, needs_info FROM core_work_items WHERE id = ?",
      ui.id,
    );
    expect(resumed.needs_info).toBeNull();
    expect(["queued", "running"]).toContain(resumed.status);
    // ui ends too: the parent's Workflow hears that its children all ended, none merged.
    await ok("workItem.cancel", { workItemId: ui.id, reason: "not needed" }, w.human);
    const told = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'workflow.event' AND instr(payload, ?) > 0",
      `split-${item.workItemId}`,
    );
    expect(told).toHaveLength(1);
    expect(JSON.parse(told[0]?.payload ?? "{}").payload).toMatchObject({ done: 0, cancelled: 2 });
  });

  it("cancels children still held when the parent ends before its plan merged", async () => {
    const w = await world();
    const { item } = await approvedSplit(w);
    await ok(
      "workItem.finish",
      { workItemId: item.workItemId, status: "rejected", reason: "no" },
      FOREMAN,
    );
    expect((await childrenOf(item.workItemId)).map((k) => k.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  it("passes the parent's PR only when it carries exactly the approved plan's files (spec-only path)", () => {
    const ci = summarizeCi(
      [
        {
          id: "ci",
          name: "ci",
          status: "completed",
          conclusion: "success",
          appSlug: "github-actions",
          url: null,
        } as never,
      ],
      "me",
    );
    const allowed = ["docs/specs/wi-1-x.md", ".kim/plans/wi-1-x.md", ".kim/designs/a.d2"];
    const packet = (files: { path: string; status: string; previousPath?: string }[]) =>
      assemblePacket({
        headSha: "a".repeat(40),
        evidence: { summary: "", criteria: [], checks: [], reviewer: null, riskFlags: [] },
        ci,
        files: files as never,
        sameModelAsImplementer: false,
        splitFiles: allowed,
      });
    expect(
      packet([
        { path: "docs/specs/wi-1-x.md", status: "added" },
        { path: ".kim/designs/a.d2", status: "modified" },
      ]).verdict,
    ).toBe("pass");
    const code = packet([
      { path: "docs/specs/wi-1-x.md", status: "added" },
      { path: "src/app.ts", status: "added" },
    ]);
    expect(code.verdict).toBe("fail");
    expect(code.reasons.join(" ")).toContain("not one of the approved plan's files: src/app.ts");
    expect(packet([{ path: ".kim/plans/wi-1-x.md", status: "added" }]).verdict).toBe("fail");
    expect(
      packet([
        { path: "docs/specs/wi-1-x.md", status: "added" },
        { path: ".kim/designs/a.d2", status: "removed" },
      ]).verdict,
    ).toBe("fail");
  });
});
