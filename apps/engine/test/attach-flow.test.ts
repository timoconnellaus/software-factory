// Spec 05 end to end in the engine: an outside PR attached to a work item runs the Workflow's
// attached path. Triage, spec and build skipped, verify on the PR's own head, the merge gate;
// pushes re-verify, a push withdraws a pending merge, and closing the PR cancels the item. The
// factory never pushes to the PR's branch.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { parseProjectPolicy } from "@software-factory/core";
import { compileItemWorkflow, engineStages } from "@software-factory/core/stages";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
  all,
  first,
  gateOpen,
  github,
  itemStatus,
  ok,
  runStage,
  triage,
  uid,
  verifyFail,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;

/** `core_stages` rows as the compiled definition says (spec 52 PR (a)): each stage run or skipped. */
function asDefinitionSays(rows: { stage: string; status: string }[]) {
  const seen = new Map<string, boolean>();
  for (const r of rows) if (!seen.has(r.stage)) seen.set(r.stage, r.status !== "skipped");
  return [...seen].filter(([stage]) =>
    ["triage", "spec", "build", "verify", "merge"].includes(stage),
  );
}

const SECRET = "test-webhook-secret";

async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await worker.fetch(
    new Request("https://software-factory.example/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": uid("delivery-"),
        "x-hub-signature-256": await sign(SECRET, body),
      },
    }),
    env,
  );
  expect(res.status).toBe(200);
  return res;
}

const pullRequestEvent = (
  w: World,
  action: string,
  pr: { number: number; headSha: string; branch: string; merged?: boolean },
) =>
  deliver("pull_request", {
    action,
    repository: { name: w.repo.repo, owner: { login: w.repo.owner } },
    pull_request: {
      number: pr.number,
      merged: pr.merged ?? false,
      head: { sha: pr.headSha, ref: pr.branch },
      base: { ref: "main" },
    },
  });

const verifyChecks = async (w: World, sha: string) =>
  ((await github.state(w.repo)).checks?.[sha] ?? []).filter((c) => c.name === "factory/verify");

/** A local session's PR, attached through the operation the `/attach` page calls. */
async function attached(w: World, branch = `tim/${uid("b")}`) {
  const pr = await github.openOutsidePull(w.repo, {
    branch,
    title: "Planning design",
    body: "Adds the planning design docs.",
  });
  const item = await ok<{ workItemId: string; branch: string }>(
    "workItem.attachPr",
    { projectId: w.projectId, prNumber: pr.number },
    w.human,
  );
  return { pr: { ...pr, branch }, item };
}

/** A push to the PR's branch by its author, and GitHub's `synchronize` delivery. */
async function pushToPr(w: World, pr: { number: number; branch: string }) {
  const headSha = await github.push(w.repo, pr.branch, undefined, ["docs/fix.md"]);
  await pullRequestEvent(w, "synchronize", { ...pr, headSha });
  return headSha;
}

const audit = async (workItemId: string) =>
  (
    await all<{ operation: string; outcome: string }>(
      "SELECT operation, outcome FROM core_audit WHERE work_item_id = ? ORDER BY at, rowid",
      workItemId,
    )
  ).map((t) => `${t.operation}:${t.outcome}`);

describe("an attached PR's Workflow (spec 05)", () => {
  it("triages, skips spec and build, verifies the PR's head and merges it at the merge gate (criteria 2, 3)", async () => {
    const w = await world();
    const { pr, item } = await attached(w);
    const branchBefore = await github.getBranchSha(w.repo, pr.branch);

    const triaged = await runStage(w, item.workItemId, "triage", (job) => {
      // The runner checks out the PR's own branch, and the prompt is about the PR.
      expect(job.repo.baseRef).toBe(pr.branch);
      expect(job.harness.prompt).toMatch(/opened outside the factory/);
      expect(job.harness.prompt).toMatch(new RegExp(`#${pr.number}`));
      return triage("large");
    });
    expect(triaged.context).toMatchObject({ attached: true, headSha: pr.headSha });
    const verified = await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.headSha).toBe(pr.headSha);
      expect(job.repo.baseRef).toBe(pr.branch);
      return verifyPass;
    });
    expect(verified.stage).toBe("verify");

    await gateOpen(item.workItemId, "merge");
    expect((await verifyChecks(w, pr.headSha))[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    const stages = await all<{ stage: string; status: string; reason: string | null }>(
      "SELECT stage, status, reason FROM core_stages WHERE work_item_id = ? ORDER BY started_at, rowid",
      item.workItemId,
    );
    expect(stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
      "intake:done",
      "triage:done",
      "spec:skipped",
      "build:skipped",
      "verify:done",
      "merge:active",
    ]);
    for (const s of stages.filter((x) => x.status === "skipped")) {
      expect(s.reason).toBe("attached PR: built outside the factory");
    }
    // The built-in Attached PR definition passes and skips the same stages (spec 52 PR (a)).
    const parsed = parseProjectPolicy(JSON.stringify({ version: 1, autonomyPolicy: "balanced" }));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(asDefinitionSays(stages)).toEqual(
      engineStages(compileItemWorkflow(parsed.policy, null, "attached"), "large").map((x) => [
        x.stage,
        x.runs,
      ]),
    );
    const size = await first<{ size: string }>(
      "SELECT size FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(size?.size).toBe("large");

    await ok("review.merge", { workItemId: item.workItemId, openedFullDiff: true }, w.human);
    await itemStatus(item.workItemId, "done");
    const merged = (await github.state(w.repo)).pulls.find((p) => p.number === pr.number);
    expect(merged?.state).toBe("merged");

    // The factory never pushed to the PR's branch.
    const ops = await audit(item.workItemId);
    expect(ops.filter((o) => /^branch\.(ensure|advance):/.test(o))).toEqual([]);
    expect(ops).toContain("pr.merge:ok");
    expect(await github.getBranchSha(w.repo, pr.branch)).toBe(branchBefore);
    expect(
      await all(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
        item.workItemId,
      ),
    ).toEqual([]);
  });

  it("waits on a failing verify, then re-verifies a new push; the old head stays red (criterion 4)", async () => {
    const w = await world();
    const { pr, item } = await attached(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "verify", () => verifyFail);

    await waitFor("the item waiting for a push", () =>
      first<{ status_reason: string }>(
        "SELECT status_reason FROM core_work_items WHERE id = ? AND status = 'waiting'",
        item.workItemId,
      ),
    ).then((row) => expect(row.status_reason).toBe("verify found problems: push a fix to the PR"));
    expect((await verifyChecks(w, pr.headSha))[0]).toMatchObject({ conclusion: "failure" });

    const newHead = await pushToPr(w, pr);
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.headSha).toBe(newHead);
      return verifyPass;
    });
    await gateOpen(item.workItemId, "merge");
    expect((await verifyChecks(w, newHead))[0]).toMatchObject({ conclusion: "success" });
    expect((await verifyChecks(w, pr.headSha))[0]).toMatchObject({ conclusion: "failure" });
    const ops = await audit(item.workItemId);
    expect(ops.filter((o) => /^branch\.(ensure|advance):/.test(o))).toEqual([]);
  });

  it("withdraws a pending merge when the PR's head moves, and re-verifies the new head (criterion 5)", async () => {
    const w = await world();
    const { pr, item } = await attached(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "verify", () => verifyPass);
    const stale = await gateOpen(item.workItemId, "merge");

    const newHead = await pushToPr(w, pr);
    expect(
      await first<{ status: string; decision: string }>(
        "SELECT status, decision FROM core_pending_actions WHERE id = ?",
        stale.id,
      ),
    ).toEqual({ status: "rejected", decision: "withdrawn" });
    // Approving the stale gate can't merge the old head.
    const refused = await ok(
      "review.merge",
      {
        workItemId: item.workItemId,
        openedFullDiff: true,
      },
      w.human,
    ).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "conflict" });
    expect((await github.state(w.repo)).pulls.find((p) => p.number === pr.number)?.state).toBe(
      "open",
    );

    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.headSha).toBe(newHead);
      return verifyPass;
    });
    const fresh = await waitFor("a new merge gate", () =>
      first<{ id: string; input: string }>(
        "SELECT id, input FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' AND status = 'pending'",
        item.workItemId,
      ),
    );
    expect(fresh.id).not.toBe(stale.id);
    expect(JSON.parse(fresh.input)).toMatchObject({ headSha: newHead });
    await ok("review.merge", { workItemId: item.workItemId, openedFullDiff: true }, w.human);
    await itemStatus(item.workItemId, "done");
    expect((await github.state(w.repo)).pulls.find((p) => p.number === pr.number)?.state).toBe(
      "merged",
    );
  });

  it("waits after a send-back at the merge gate, with the note, until a push", async () => {
    const w = await world();
    const { pr, item } = await attached(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "verify", () => verifyPass);
    await gateOpen(item.workItemId, "merge");
    await ok(
      "review.sendBack",
      { workItemId: item.workItemId, note: "Rename the ADR", openedFullDiff: true },
      w.human,
    );
    const waiting = await waitFor("the item waiting", () =>
      first<{ status_reason: string }>(
        "SELECT status_reason FROM core_work_items WHERE id = ? AND status = 'waiting'",
        item.workItemId,
      ),
    );
    expect(waiting.status_reason).toBe("Sent back at review: Rename the ADR");
    const newHead = await pushToPr(w, pr);
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.headSha).toBe(newHead);
      return verifyPass;
    });
    await gateOpen(item.workItemId, "merge");
    // A person's PR sent back at review isn't a factory failure: no incident.
    expect(
      await all("SELECT id FROM core_incidents WHERE source_work_item_id = ?", item.workItemId),
    ).toEqual([]);
  });

  it("cancels the item when the PR is closed without merging (criterion 7)", async () => {
    const w = await world();
    const { pr, item } = await attached(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await github.closePull(w.repo, pr.number);
    await pullRequestEvent(w, "closed", { ...pr, merged: false });
    await itemStatus(item.workItemId, "cancelled");
    const row = await first<{ status_reason: string }>(
      "SELECT status_reason FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row?.status_reason).toBe("the pull request was closed without merging");
  });
});
