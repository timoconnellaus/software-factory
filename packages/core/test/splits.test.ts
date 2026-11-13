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
import {
  call,
  first,
  newItem,
  ok,
  RUNNER_ACTOR,
  refusal,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

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
  // The Workflow version that splits (its number moves at merge time; the feature doesn't).
  await rows(
    "UPDATE core_work_items SET workflow_version = ? WHERE id = ?",
    SPLITS_VERSION,
    item.workItemId,
  );
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

import { splitDigest, splitProblem } from "@software-factory/runner-contract";
import { assemblePacket, summarizeCi, WORKFLOW_VERSION_FEATURES } from "../src/index.ts";

const SPLITS_VERSION = Number(
  Object.entries(WORKFLOW_VERSION_FEATURES).find(([, f]) => f.has("splits"))?.[0],
);

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

/** What the plan's screen sends with an approval: the version and the split's digest. */
const shown = async (version = 1, children = SPLIT.children) => ({
  specVersion: version,
  splitDigest: await splitDigest(children as never),
});

/** A parent planned with SPLIT, at the gate, approved by a person. */
async function approvedSplit(w: W) {
  const { item, agent } = await planning(w);
  const { specId } = await agent<{ specId: string }>("spec.revise", SPLIT);
  await agent("planning.news");
  await agent("planning.ready");
  const gate = await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
  expect(gate.status).toBe("pending");
  await ok("spec.approve", { workItemId: item.workItemId, ...(await shown()) }, w.human);
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
    const again = await call(
      "spec.approve",
      { workItemId: item.workItemId, ...(await shown()) },
      w.human,
    );
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
    const committed = await ok<{ commitSha: string }>(
      "spec.commit",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    // The plan's PR merges (split.release checks GitHub says so).
    const branch = (
      await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        item.workItemId,
      )
    ).branch;
    const pr = await services.github.openPullRequest(w.repo, {
      head: branch,
      base: "main",
      title: "plan",
      body: "",
    });
    await rows(
      "UPDATE core_work_items SET pr_number = ?, status = 'waiting' WHERE id = ?",
      pr.number,
      item.workItemId,
    );
    await services.github.mergePullRequest(w.repo, {
      number: pr.number,
      sha: committed.commitSha,
      method: "merge",
    });
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

  it("passes the parent's PR only on exactly the files its commit wrote, with that content (review of #171)", () => {
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
    const committed = [
      { path: "docs/specs/wi-1-x.md", sha256: "a" },
      { path: ".kim/plans/wi-1-x.md", sha256: "a" },
      { path: ".kim/designs/a.d2", sha256: "b" },
    ];
    const atHead = {
      "docs/specs/wi-1-x.md": "a",
      ".kim/plans/wi-1-x.md": "a",
      ".kim/designs/a.d2": "b",
    };
    const all = committed.map((c) => ({ path: c.path, status: "added" }));
    const packet = (
      files: { path: string; status: string; previousPath?: string }[],
      head: Record<string, string | null> = atHead,
    ) =>
      assemblePacket({
        headSha: "a".repeat(40),
        evidence: { summary: "", criteria: [], checks: [], reviewer: null, riskFlags: [] },
        ci,
        files: files as never,
        sameModelAsImplementer: false,
        splitFiles: committed,
        splitAtHead: head,
      });
    expect(packet(all).verdict).toBe("pass");
    // An extra file.
    const extra = packet([...all, { path: "src/app.ts", status: "added" }]);
    expect(extra.verdict).toBe("fail");
    expect(extra.reasons.join(" ")).toContain("not one of the approved plan's files: src/app.ts");
    // A file identical to main isn't in the diff, but it's at the head: it passes (review of #171).
    expect(packet(all.slice(1)).verdict).toBe("pass");
    // A file missing at the head.
    const missing = packet(all, { ...atHead, "docs/specs/wi-1-x.md": null });
    expect(missing.verdict).toBe("fail");
    expect(missing.reasons.join(" ")).toContain("isn't at the head: docs/specs/wi-1-x.md");
    // A link to identical content isn't a file.
    const link = packet(all, { ...atHead, ".kim/designs/a.d2": "mode:120000" });
    expect(link.verdict).toBe("fail");
    expect(link.reasons.join(" ")).toContain("a link or not a plain file");
    // A changed byte in an approved file.
    const changed = packet(all, { ...atHead, ".kim/designs/a.d2": "c" });
    expect(changed.verdict).toBe("fail");
    expect(changed.reasons.join(" ")).toContain("changed after approval: .kim/designs/a.d2");
    // A removal.
    expect(
      packet([...all.slice(0, 2), { path: ".kim/designs/a.d2", status: "removed" }]).verdict,
    ).toBe("fail");
    // Nothing recorded: nothing can match.
    expect(
      assemblePacket({
        headSha: "a".repeat(40),
        evidence: { summary: "", criteria: [], checks: [], reviewer: null, riskFlags: [] },
        ci,
        files: [] as never,
        sameModelAsImplementer: false,
        splitFiles: [],
        splitAtHead: {},
      }).verdict,
    ).toBe("fail");
  });

  it("approves a split only as it was shown, and never through the generic gate card (review of #171)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPLIT);
    await agent("planning.news");
    await agent("planning.ready");
    await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
    // No digest, another version, or other children: refused, and nothing is created.
    for (const bound of [{}, await shown(2), await shown(1, [child("api")])]) {
      const refused = await refusal(
        ok("spec.approve", { workItemId: item.workItemId, ...bound }, w.human),
      );
      expect(refused.message).toMatch(/approve it on the plan's screen/);
    }
    const pa = await first<{ id: string }>(
      "SELECT id FROM core_pending_actions WHERE work_item_id = ? AND kind = 'spec' AND status = 'pending'",
      item.workItemId,
    );
    await refusal(ok("approval.decide", { pendingActionId: pa.id, decision: "approved" }, w.human));
    expect(await childrenOf(item.workItemId)).toEqual([]);
    await ok("spec.approve", { workItemId: item.workItemId, ...(await shown()) }, w.human);
    expect(await childrenOf(item.workItemId)).toHaveLength(2);
  });

  it("holds the children until the parent's plan merged, whoever releases them (review of #171)", async () => {
    const w = await world();
    const { item } = await approvedSplit(w);
    const [api] = await childrenOf(item.workItemId);
    const refused = await refusal(ok("workItem.release", { workItemId: api?.id }, w.human));
    expect(refused.message).toMatch(/hasn't merged yet/);
    // Nor shaped (review of #171, round 2): shaping triages and plans it.
    const shaped = await refusal(ok("workItem.shape", { workItemId: api?.id }, w.human));
    expect(shaped.message).toMatch(/hasn't merged yet/);
    // Nor pulled if queued by hand: the pull's guarded write leaves it.
    await rows("UPDATE core_work_items SET status = 'queued' WHERE id = ?", api?.id);
    await ok("queue.pull", { projectId: w.projectId }, { type: "scheduler", id: "scheduler" });
    expect(
      (await first<{ status: string }>("SELECT status FROM core_work_items WHERE id = ?", api?.id))
        .status,
    ).toBe("queued");
    // split.release is refused until the plan's PR merged.
    await rows(
      "UPDATE core_specs SET status = 'approved' WHERE work_item_id = ? AND status = 'draft'",
      item.workItemId,
    );
    const early = await refusal(ok("split.release", { workItemId: item.workItemId }, FOREMAN));
    expect(early.message).toMatch(/hasn't merged/);
  });

  it("lets a child skip planning only while its body and criteria are the approved slice (review of #171)", async () => {
    const w = await world();
    const { item } = await approvedSplit(w);
    const [api, ui] = await childrenOf(item.workItemId);
    if (!api || !ui) throw new Error("expected two children");
    await rows(
      "UPDATE core_work_items SET status = 'running', stage = 'triage' WHERE id IN (?, ?)",
      api.id,
      ui.id,
    );
    // Someone edited ui's body while it waited.
    await rows("UPDATE core_work_items SET body = body || ' and email it' WHERE id = ?", ui.id);
    const triaged = (id: string) =>
      ok<{ specRequired: boolean; reason: string }>(
        "workItem.triage",
        {
          workItemId: id,
          result: {
            size: "medium",
            domains: [],
            acceptanceCriteria: ["Something triage made up"],
            specRequested: "skip",
            reason: "the slice is complete",
          },
        },
        FOREMAN,
      );
    const a = await triaged(api.id);
    expect(a.specRequired).toBe(false);
    expect(a.reason).toMatch(/approved it with the parent's spec/);
    // The approved criteria stand, not triage's.
    const spec = await first<{ acceptance_criteria: string }>(
      "SELECT acceptance_criteria FROM core_specs WHERE work_item_id = ? ORDER BY version DESC",
      api.id,
    );
    expect(spec.acceptance_criteria).toContain("The api works [parent]");
    expect(spec.acceptance_criteria).not.toContain("made up");
    // ui changed: it plans under the policy like any item.
    expect((await triaged(ui.id)).specRequired).toBe(true);
  });

  it("a parent whose plan merged outside the factory waits for its children, then closes (review of #169)", async () => {
    const w = await world();
    const { item } = await approvedSplit(w);
    await rows(
      "UPDATE core_specs SET status = 'approved' WHERE work_item_id = ? AND status = 'draft'",
      item.workItemId,
    );
    const committed = await ok<{ commitSha: string }>(
      "spec.commit",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    const branch = (
      await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        item.workItemId,
      )
    ).branch;
    const pr = await services.github.openPullRequest(w.repo, {
      head: branch,
      base: "main",
      title: "plan",
      body: "",
    });
    await rows(
      "UPDATE core_work_items SET pr_number = ?, head_sha = ?, status = 'waiting' WHERE id = ?",
      pr.number,
      committed.commitSha,
      item.workItemId,
    );
    await ok(
      "verify.refresh",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        headSha: committed.commitSha,
        prNumber: pr.number,
        trigger: "closed",
        merged: true,
        mergedBy: "octo",
      },
      { type: "intake", id: "github" },
    );
    const parent = () =>
      first<{ status: string; awaiting_children: number }>(
        "SELECT status, awaiting_children FROM core_work_items WHERE id = ?",
        item.workItemId,
      );
    expect(await parent()).toEqual({ status: "waiting", awaiting_children: 1 });
    const kids = await childrenOf(item.workItemId);
    expect(kids.every((k) => k.status !== "ready")).toBe(true);
    // Its old Workflow ending doesn't end it.
    await ok(
      "workItem.finish",
      { workItemId: item.workItemId, status: "rejected", reason: "gate closed" },
      FOREMAN,
    );
    expect((await parent()).status).toBe("waiting");
    // The last child ending closes it.
    for (const k of kids) {
      await ok("workItem.cancel", { workItemId: k.id, reason: "not needed" }, w.human);
    }
    expect((await parent()).status).toBe("cancelled");
  });

  it("closes held children's questions when their parent ends before its plan merged (review of #169)", async () => {
    const w = await world();
    const { item } = await approvedSplit(w);
    const [api] = await childrenOf(item.workItemId);
    await rows(
      "INSERT INTO core_questions (id, work_item_id, project_id, org_id, assignee_user_id, planning_round, timeout_at, asked_by, created_at, domain, prompt, options, kind, blocking, irreversible, position) SELECT 'q_held', id, project_id, org_id, requester_user_id, 0, '2099-01-01T00:00:00.000Z', 'test', '2026-11-13T00:00:00.000Z', 'product', 'Which?', '[]', 'text', 1, 0, 1 FROM core_work_items WHERE id = ?",
      api?.id,
    );
    await ok(
      "workItem.finish",
      { workItemId: item.workItemId, status: "rejected", reason: "no" },
      FOREMAN,
    );
    expect(
      (await first<{ status: string }>("SELECT status FROM core_questions WHERE id = 'q_held'"))
        .status,
    ).toBe("withdrawn");
    expect((await childrenOf(item.workItemId)).every((k) => k.status === "cancelled")).toBe(true);
  });
});
