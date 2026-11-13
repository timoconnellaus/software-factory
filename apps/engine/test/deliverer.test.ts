// The babysitter's deliverer (spec 53, ADR 0580, 0585): from Workflow v11 an approval only says the
// head may merge; the engine's per-repository pass lands it. merge-queue.test.ts covers the queue's
// behaviour (order, update, CI, conflict, red CI, cancel), now run by the deliverer; this file covers
// what is the deliverer's own: who lands it, the outcome read back, and one pass at a time.

import { env } from "cloudflare:workers";
import { BABYSITTER, FOREMAN, operations } from "@software-factory/core";
import { afterEach, describe, expect, it } from "vitest";
import { deliverRepository, deliverTestSeams } from "../src/deliver/deliverer.ts";
import { mobileTestSeams } from "../src/mobile.ts";
import {
  all,
  BALANCED,
  build,
  call,
  first,
  gateHead,
  gateOpen,
  github,
  itemStatus,
  ok,
  runStage,
  triage,
  verifyFail,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;

const CI = (conclusion: string | null) => [
  {
    name: "ci",
    status: conclusion ? ("completed" as const) : ("in_progress" as const),
    conclusion,
    appSlug: "github-actions",
    url: null,
  },
];

async function toMergeGate(w: World, title: string, file: string) {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
  await runStage(w, item.workItemId, "triage", () => triage("small"));
  await runStage(w, item.workItemId, "build", () => build([file]));
  await runStage(w, item.workItemId, "verify", () => verifyPass);
  await gateOpen(item.workItemId, "merge");
  return item.workItemId;
}

const approve = async (w: World, workItemId: string) =>
  ok(
    "review.merge",
    { workItemId, openedFullDiff: true, headSha: await gateHead(workItemId) },
    w.human,
  );

const merges = (workItemId: string) =>
  all<{ actor_type: string; actor_id: string; outcome: string }>(
    "SELECT actor_type, actor_id, outcome FROM core_audit WHERE operation = 'pr.merge' AND work_item_id = ? AND outcome = 'ok'",
    workItemId,
  );

describe("the babysitter's deliverer (v11)", () => {
  it("lands an approved merge as the babysitter, and the entry keeps how it ended", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Delivered", "src/a.ts");
    await approve(w, a);
    await itemStatus(a, "done");

    const landed = await merges(a);
    expect(landed).toEqual([{ actor_type: "agent", actor_id: "babysitter", outcome: "ok" }]);
    const entry = await first<{ driver: string; status: string; outcome: string }>(
      "SELECT driver, status, outcome FROM core_merge_queue WHERE work_item_id = ?",
      a,
    );
    expect(entry).toEqual({ driver: "babysitter", status: "merged", outcome: "merged" });
    // A Workflow that missed `delivered-<item>` reads the outcome back from its position.
    const pos = await ok<{ queued: boolean; outcome: string | null }>(
      "mergeQueue.position",
      { workItemId: a },
      w.human,
    );
    expect(pos).toMatchObject({ queued: false, outcome: "merged" });
    // The item's Workflow neither updated nor merged anything itself (its pr.merge only opened the gate).
    const own = await all<{ operation: string }>(
      "SELECT operation FROM core_audit WHERE work_item_id = ? AND actor_id = 'foreman' AND operation IN ('mergeQueue.update', 'pr.merge') AND outcome = 'ok'",
      a,
    );
    expect(own).toEqual([]);
  });

  it("runs one pass per repository at a time: two at once merge once", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Raced");
    // CI turns green on the head, with no webhook: two passes start at once.
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    await Promise.all([
      deliverRepository(env, u.project_id, u.repositoryId),
      deliverRepository(env, u.project_id, u.repositoryId),
    ]);
    await itemStatus(u.a, "done");
    expect(await merges(u.a)).toHaveLength(1);
    const state = await first<{ running_until: string | null }>(
      "SELECT running_until FROM core_delivery_state WHERE project_id = ?",
      u.project_id,
    );
    expect(state?.running_until).toBeNull();
  });

  afterEach(() => {
    deliverTestSeams.beforeMark = null;
    deliverTestSeams.beforeLand = null;
    mobileTestSeams.beforeCommit = null;
  });

  /**
   * A at its merge gate, approved and queued, CI pending on its head, so the deliverer waits there.
   * (A head brought up to date with a moved main is verified again before it merges, spec 53 PR c,
   * so the pause is on the approved head.)
   */
  async function updatedAndWaiting(w: World, title: string) {
    const a = await toMergeGate(w, title, "src/a.ts");
    const head = await first<{ head_sha: string }>(
      "SELECT head_sha FROM core_work_items WHERE id = ?",
      a,
    );
    await github.setChecks(w.repo, String(head?.head_sha), CI(null));
    await approve(w, a);
    const updated = await waitFor("A queued, waiting for CI", () =>
      first<{ head_sha: string; project_id: string; pending_action_id: string }>(
        "SELECT head_sha, project_id, pending_action_id FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued'",
        a,
      ),
    );
    const item = await first<{ repository_id: string; pr_number: number }>(
      "SELECT repository_id, pr_number FROM core_work_items WHERE id = ?",
      a,
    );
    return {
      a,
      ...updated,
      repositoryId: String(item?.repository_id),
      pr: Number(item?.pr_number),
    };
  }

  // Review of #103, the probe run: a cancelled item could still merge.
  it("a cancel between ci.read and the merging mark stops the merge: the approval dies with the item", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Cancelled mid-delivery");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    deliverTestSeams.beforeMark = async (id) => {
      deliverTestSeams.beforeMark = null;
      await ok("workItem.cancel", { workItemId: id, reason: "not wanted" }, w.human);
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    expect(deliverTestSeams.beforeMark).toBeNull(); // the seam ran
    expect(await merges(u.a)).toEqual([]);
    expect((await github.state(w.repo)).pulls.every((p) => p.state === "open")).toBe(true);
    const approval = await first<{ status: string; decision: string }>(
      "SELECT status, decision FROM core_pending_actions WHERE id = ?",
      u.pending_action_id,
    );
    expect(approval).toEqual({ status: "rejected", decision: "withdrawn" });
  });

  it("pr.merge refuses a cancelled item even with its approval, whoever calls it", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Cancelled, then merged by hand");
    await ok("workItem.cancel", { workItemId: u.a, reason: "not wanted" }, w.human);
    for (const actor of [BABYSITTER, FOREMAN]) {
      await expect(
        call(
          "pr.merge",
          { workItemId: u.a, headSha: u.head_sha, touchesFactoryConfig: false },
          actor,
          { approvalId: u.pending_action_id },
        ),
      ).rejects.toMatchObject({ code: "bad_approval" });
    }
    expect((await github.state(w.repo)).pulls.every((p) => p.state === "open")).toBe(true);
  });

  // Second review of #103, the probe run: a cancel inside the 1-3 s GitHub takes to merge left the
  // PR merged, the audit `failed`, the approval unused and the item cancelled.
  it("a cancel while the babysitter is merging is refused: this is merging", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Cancelled in the merge window");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    let refused: unknown = null;
    deliverTestSeams.beforeLand = async (id) => {
      deliverTestSeams.beforeLand = null;
      refused = await call("workItem.cancel", { workItemId: id, reason: "not wanted" }, w.human)
        .then(() => null)
        .catch((e: unknown) => e);
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    expect(refused).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/is merging/),
    });
    await itemStatus(u.a, "done");
    expect(await merges(u.a)).toHaveLength(1);
  });

  it("a cancel that commits while GitHub merges loses: the merge is recorded and the item is done", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Cancelled under the merge");
    mobileTestSeams.beforeCommit = async (op) => {
      if (op !== "pr.merge") return;
      mobileTestSeams.beforeCommit = null;
      // A cancel that got in after pr.merge's reads (no merging mark: pr.merge called directly).
      await ok("workItem.cancel", { workItemId: u.a, reason: "not wanted" }, w.human);
    };
    await expect(
      call(
        "pr.merge",
        { workItemId: u.a, headSha: u.head_sha, touchesFactoryConfig: false },
        BABYSITTER,
        { approvalId: u.pending_action_id },
      ),
    ).rejects.toMatchObject({ code: "conflict", details: { recorded: true } });
    expect((await github.state(w.repo)).pulls[0]?.state).toBe("merged");
    const item = await first<{ status: string; status_reason: string }>(
      "SELECT status, status_reason FROM core_work_items WHERE id = ?",
      u.a,
    );
    expect(item).toEqual({
      status: "done",
      status_reason: "cancelled after its merge had started",
    });
    const approval = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      u.pending_action_id,
    );
    expect(approval?.status).toBe("applied");
    const entry = await first<{ status: string; outcome: string }>(
      "SELECT status, outcome FROM core_merge_queue WHERE work_item_id = ?",
      u.a,
    );
    expect(entry).toEqual({ status: "merged", outcome: "merged" });
    expect(await merges(u.a)).toHaveLength(1); // the audit says it merged
  });

  it("a takeover while GitHub merges: the merge is recorded, and the next pass does not merge again", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Taken over in the merge window");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    mobileTestSeams.beforeCommit = async (op) => {
      if (op !== "pr.merge") return;
      mobileTestSeams.beforeCommit = null;
      // The pass's lease runs out and another pass takes the queue while GitHub merges.
      await env.DB.prepare(
        "UPDATE core_delivery_state SET rev = rev + 1, running_until = NULL WHERE project_id = ?",
      )
        .bind(u.project_id)
        .run();
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    await deliverRepository(env, u.project_id, u.repositoryId);
    await itemStatus(u.a, "done");
    expect(await merges(u.a)).toHaveLength(1);
    // GitHub was asked to merge once: a second ask would have been refused (405) and sent it back.
    const asked = await all<{ outcome: string }>(
      "SELECT outcome FROM core_audit WHERE operation = 'pr.merge' AND work_item_id = ? AND actor_id = 'babysitter'",
      u.a,
    );
    expect(asked.map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("pr.merge records a PR GitHub already merged at the head as merged, not merged again", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Merged by a pass that died");
    // A pass merged on GitHub and died before anything was recorded.
    expect(
      await github.mergePullRequest(w.repo, { number: u.pr, sha: u.head_sha, method: "merge" }),
    ).toMatchObject({ merged: true });
    // GitHub refuses a second merge, as the real API does (405).
    expect(
      await github.mergePullRequest(w.repo, { number: u.pr, sha: u.head_sha, method: "merge" }),
    ).toEqual({ merged: false, reason: "Pull Request is not mergeable" });
    const r = await call(
      "pr.merge",
      { workItemId: u.a, headSha: u.head_sha, touchesFactoryConfig: false },
      BABYSITTER,
      { approvalId: u.pending_action_id },
    );
    expect(r).toMatchObject({ status: "ok", output: { merged: true } });
    expect(await merges(u.a)).toHaveLength(1);
  });

  // Review of #103: two passes over one queue. A pass whose lease expired and was taken over must
  // change nothing, so it can't record "left, failed" for an item the other pass is merging.
  it("a pass that lost its lease is fenced: the other pass's merge stands", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Two passes");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    let b: Promise<void> | null = null;
    let release: () => void = () => {};
    const aMayGo = new Promise<void>((r) => {
      release = r;
    });
    const aDone = { value: false };
    let aDoneResolve: () => void = () => {};
    const aFinished = new Promise<void>((r) => {
      aDoneResolve = r;
    });
    // Pass A stops before it lands. Its lease runs out and pass B takes the queue over.
    deliverTestSeams.beforeLand = async () => {
      deliverTestSeams.beforeLand = null;
      const later = () => new Date(Date.now() + 5 * 60_000);
      // B merges on GitHub; before its batch commits, A goes on (GitHub now refuses a second merge).
      mobileTestSeams.beforeCommit = async (op) => {
        if (op !== "pr.merge") return;
        mobileTestSeams.beforeCommit = null;
        await github.refuseNextMerge(w.repo, u.pr, "Pull Request is not mergeable");
        release();
        await aFinished;
      };
      b = deliverRepository(env, u.project_id, u.repositoryId, later);
      await aMayGo;
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    aDone.value = true;
    aDoneResolve();
    await b;
    await itemStatus(u.a, "done");
    expect(await merges(u.a)).toHaveLength(1);
    const entry = await first<{ status: string; outcome: string }>(
      "SELECT status, outcome FROM core_merge_queue WHERE work_item_id = ?",
      u.a,
    );
    expect(entry).toEqual({ status: "merged", outcome: "merged" });
    // A's late calls were refused as fenced and wrote nothing.
    const fenced = await all<{ operation: string }>(
      "SELECT operation FROM core_audit WHERE work_item_id = ? AND actor_id = 'babysitter' AND outcome = 'fenced'",
      u.a,
    );
    expect(fenced.map((r) => r.operation)).toEqual(["pr.merge"]);
  });

  // Review of #103: a merge GitHub refuses as stale is re-snapshotted, not sent back to build.
  it("re-snapshots a merge GitHub refused because main moved: updates, verifies the new head, lands", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Main moved under the merge");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    deliverTestSeams.beforeLand = async () => {
      deliverTestSeams.beforeLand = null;
      await github.push(w.repo, "main", undefined, ["CHANGELOG.md"]);
      await github.refuseNextMerge(w.repo, u.pr, "Base branch was modified");
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    // Updated again; the approved change on a new head is verified there before it merges.
    const again = await waitFor("updated and sent to verify", () =>
      first<{ head_sha: string; updates: number }>(
        "SELECT head_sha, updates FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'reverify'",
        u.a,
      ),
    );
    expect(again.updates).toBe(1);
    expect(again.head_sha).not.toBe(u.head_sha);
    await github.setCiDefault(w.repo, CI("success"));
    await runStage(w, u.a, "verify", () => verifyPass);
    await itemStatus(u.a, "done");
    expect(await merges(u.a)).toHaveLength(1);
  });

  // Main's pr.merge closes an approval when GitHub says the head moved; on a v11 item the
  // babysitter owns that: pr.merge leaves the approval and says why in details, not only in text.
  it("a head that moves under the babysitter's merge: pr.merge leaves the approval to it, it withdraws it and the item re-verifies", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Head moved under the merge");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    const branch = String(
      (await first<{ branch: string }>("SELECT branch FROM core_work_items WHERE id = ?", u.a))
        ?.branch,
    );
    deliverTestSeams.beforeLand = async () => {
      deliverTestSeams.beforeLand = null;
      await github.push(w.repo, branch, undefined, ["src/late.ts"]);
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    const refused = await first<{ reason: string }>(
      "SELECT reason FROM core_audit WHERE operation = 'pr.merge' AND work_item_id = ? AND actor_id = 'babysitter' AND outcome = 'failed'",
      u.a,
    );
    expect(refused?.reason).toMatch(/merge refused: head moved/);
    expect(refused?.reason).not.toMatch(/review the new commit/);
    // pr.merge didn't close it behind the babysitter's back; the babysitter re-snapshotted and,
    // finding a push it didn't make, withdrew it itself (ADR 0582): its note, not pr.merge's.
    const ended = await first<{ outcome: string; end_reason: string | null }>(
      "SELECT outcome, end_reason FROM core_merge_queue WHERE work_item_id = ? ORDER BY enqueued_at DESC LIMIT 1",
      u.a,
    );
    expect(ended?.outcome).toBe("withdrawn");
    expect(ended?.end_reason ?? "").not.toMatch(/pr\.merge failed after approval/);
    const approval = await first<{ decision: string; note: string | null }>(
      "SELECT decision, note FROM core_pending_actions WHERE id = ?",
      u.pending_action_id,
    );
    expect(approval?.decision).toBe("withdrawn");
    expect(approval?.note ?? "").toMatch(/^withdrawn: /);
    expect(approval?.note ?? "").not.toMatch(/review the new commit/);
    // v12: back to verify on the new head, not to build; then the merge gate.
    await runStage(w, u.a, "verify", () => verifyPass);
    await gateOpen(u.a, "merge");
    expect(
      await all(
        "SELECT id FROM core_stages WHERE work_item_id = ? AND stage = 'build' AND status = 'active'",
        u.a,
      ),
    ).toEqual([]);
    expect(await merges(u.a)).toEqual([]);
  });

  // Review of #134: GitHub's `closed` webhook can land while the babysitter is merging, before
  // pr.merge's batch commits. Its merging mark makes it the factory's own merge, never "outside".
  it("a merged webhook while the babysitter is merging is the factory's own: the item ends merged by it", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Webhook beats the batch");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    const outcomes: string[] = [];
    deliverTestSeams.beforeLand = async (id) => {
      deliverTestSeams.beforeLand = null;
      // The approval alone would say so too: hide it, so the mark is what decides.
      await env.DB.prepare("UPDATE core_pending_actions SET status = 'pending' WHERE id = ?")
        .bind(u.pending_action_id)
        .run();
      const r = await ok<{ outcome: string }>(
        "verify.refresh",
        {
          repo: { owner: w.repo.owner, name: w.repo.repo },
          headSha: u.head_sha,
          prNumber: u.pr,
          trigger: "closed",
          merged: true,
        },
        { type: "intake", id: "github" },
      );
      outcomes.push(r.outcome);
      await env.DB.prepare("UPDATE core_pending_actions SET status = 'approved' WHERE id = ?")
        .bind(u.pending_action_id)
        .run();
      expect(
        (await first<{ status: string }>("SELECT status FROM core_work_items WHERE id = ?", id))
          ?.status,
      ).not.toBe("done");
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    expect(outcomes).toEqual(["ignored"]);
    await itemStatus(u.a, "done");
    const row = await first<{ status_reason: string | null }>(
      "SELECT status_reason FROM core_work_items WHERE id = ?",
      u.a,
    );
    expect(row?.status_reason ?? "").not.toMatch(/outside the factory/);
    expect(await merges(u.a)).toHaveLength(1);
  });

  it("asks GitHub to update a head at most MAX_UPDATES times, then holds it", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Main keeps moving");
    await env.DB.prepare("UPDATE core_merge_queue SET updates = 1 WHERE work_item_id = ?")
      .bind(u.a)
      .run();
    await github.push(w.repo, "main", undefined, ["CHANGELOG.md"]);
    const r = await ok<{ state: string; reason: string }>(
      "mergeQueue.update",
      { workItemId: u.a, maxUpdates: 1 },
      BABYSITTER,
    );
    expect(r.state).toBe("held");
    expect(r.reason).toMatch(/updated 1 times/);
  });

  // Second review of #103: at the bound the deliverer sent good, approved work back to build.
  it("at the update bound holds the item and asks a person; their answer lands it, no rebuild", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Main never stops");
    await env.DB.prepare("UPDATE core_merge_queue SET updates = 3 WHERE work_item_id = ?")
      .bind(u.a)
      .run();
    await github.push(w.repo, "main", undefined, ["CHANGELOG.md"]);
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    await deliverRepository(env, u.project_id, u.repositoryId);
    const q = await waitFor("a person asked", () =>
      first<{ id: string; prompt: string; options: string }>(
        "SELECT id, prompt, options FROM core_questions WHERE work_item_id = ? AND status = 'open' AND asked_by = 'babysitter'",
        u.a,
      ),
    );
    expect(q.prompt).toMatch(/keeps moving: #\d+ was updated 3 times/);
    const held = await first<{ status: string; hold_question_id: string }>(
      "SELECT status, hold_question_id FROM core_merge_queue WHERE work_item_id = ?",
      u.a,
    );
    expect(held).toEqual({ status: "queued", hold_question_id: q.id });
    // Another pass while it waits asks nothing more and sends nothing back.
    await deliverRepository(env, u.project_id, u.repositoryId);
    expect(
      await all(
        "SELECT id FROM core_questions WHERE work_item_id = ? AND asked_by = 'babysitter'",
        u.a,
      ),
    ).toHaveLength(1);

    await github.setCiDefault(w.repo, CI("success"));
    await ok(
      "question.answer",
      { questionId: q.id, answer: "Update once more, and merge when CI passes" },
      w.human,
    );
    // One more update; the approved change on the new head is verified there, then it lands.
    await waitFor("sent to verify", () =>
      first("SELECT id FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'reverify'", u.a),
    );
    await runStage(w, u.a, "verify", () => verifyPass);
    await itemStatus(u.a, "done");
    const entry = await first<{ updates: number; status: string }>(
      "SELECT updates, status FROM core_merge_queue WHERE work_item_id = ? ORDER BY enqueued_at DESC LIMIT 1",
      u.a,
    );
    expect(entry).toEqual({ updates: 4, status: "merged" });
    const builds = await all(
      "SELECT id FROM core_stages WHERE work_item_id = ? AND stage = 'build'",
      u.a,
    );
    expect(builds).toHaveLength(1); // never sent back to build
  });

  it("never takes an item with no repository (one lease per repository)", async () => {
    const w = await world();
    const a = await toMergeGate(w, "No repository", "src/a.ts");
    const row = await first<{ head_sha: string }>(
      "SELECT head_sha FROM core_work_items WHERE id = ?",
      a,
    );
    await env.DB.prepare("UPDATE core_work_items SET repository_id = NULL WHERE id = ?")
      .bind(a)
      .run();
    const gate = await first<{ id: string }>(
      "SELECT id FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' AND status = 'pending'",
      a,
    );
    await expect(
      call(
        "mergeQueue.enter",
        {
          workItemId: a,
          headSha: String(row?.head_sha),
          pendingActionId: String(gate?.id),
          driver: "babysitter",
        },
        FOREMAN,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("the approval across a merge of main (ADR 0582)", () => {
  const files = (...paths: string[]) => paths;

  async function ids(a: string) {
    const row = await first<{ project_id: string; repository_id: string; pr_number: number }>(
      "SELECT project_id, repository_id, pr_number FROM core_work_items WHERE id = ?",
      a,
    );
    return {
      projectId: String(row?.project_id),
      repositoryId: String(row?.repository_id),
      pr: Number(row?.pr_number),
    };
  }
  const withdrawnEntry = (a: string) =>
    waitFor("withdrawn", () =>
      first<{
        head_sha: string;
        approved_sha: string;
        pending_action_id: string;
        end_reason: string;
      }>(
        "SELECT head_sha, approved_sha, pending_action_id, end_reason FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'withdrawn'",
        a,
      ),
    );
  /** What a withdrawal must leave: the approval closed, nothing carried, nothing merged. */
  async function expectWithdrawn(w: World, a: string) {
    const ended = await withdrawnEntry(a);
    expect(ended.head_sha).not.toBe(ended.approved_sha);
    const approval = await first<{ status: string; decision: string }>(
      "SELECT status, decision FROM core_pending_actions WHERE id = ?",
      ended.pending_action_id,
    );
    expect(approval).toEqual({ status: "rejected", decision: "withdrawn" });
    // No packet and no passing factory/verify on the new head: nobody can merge it on GitHub.
    const packet = await first(
      "SELECT id FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
      a,
      ended.head_sha,
    );
    expect(packet).toBeNull();
    const checks = await github.listCheckRuns(w.repo, ended.head_sha);
    expect(checks.some((c) => c.name === "factory/verify" && c.conclusion === "success")).toBe(
      false,
    );
    expect(await merges(a)).toHaveLength(0);
    return ended;
  }

  // Second review of #105: the approval survived, but factory/verify on the new head came from the
  // old head's packet. Now the new head is verified on its own, then the approval carries over.
  it("survives a clean merge only after the new head passes its own verification", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Same change", files("src/a.ts"));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await approve(w, a);
    const ended = await waitFor("reverify", () =>
      first<{
        head_sha: string;
        approved_sha: string;
        pending_action_id: string;
        approved_digest: string | null;
      }>(
        "SELECT head_sha, approved_sha, pending_action_id, approved_digest FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'reverify'",
        a,
      ),
    );
    expect(ended.approved_digest).toMatch(/^p1:[0-9a-f]{64}$/);
    expect(ended.head_sha).not.toBe(ended.approved_sha);
    // Nothing from the old head's evidence on the new one: no packet, no passing factory/verify.
    expect(
      await first(
        "SELECT id FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
        a,
        ended.head_sha,
      ),
    ).toBeNull();
    const checks = await github.listCheckRuns(w.repo, ended.head_sha);
    expect(checks.some((c) => c.name === "factory/verify" && c.conclusion === "success")).toBe(
      false,
    );
    expect(await merges(a)).toHaveLength(0);
    // The approval still holds, waiting for the new head's verification.
    const approval = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      ended.pending_action_id,
    );
    expect(approval?.status).toBe("approved");
    // The verify job runs again on the new head; once it passes the approval carries over: no
    // second merge gate, and it lands.
    await runStage(w, a, "verify", (job) => {
      expect(job.harness.prompt).toContain(ended.head_sha);
      return verifyPass;
    });
    await itemStatus(a, "done");
    expect(await merges(a)).toHaveLength(1);
    const gates = await all(
      "SELECT id FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
      a,
    );
    expect(gates).toHaveLength(1);
  });

  // Spec 06's criteria for the babysitter, now that an updated head is verified again (spec 53 c).
  it("lands two approved merges in order, each verified again on its updated head", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "First in line", files("src/a.ts"));
    const b = await toMergeGateWith(w, "Second in line", files("src/b.ts"));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    // One at a time (the test's runner claims whichever job is next): A lands, then B is updated
    // against A's merge, verified there, and lands.
    for (const id of [a, b]) {
      await approve(w, id);
      await waitFor("sent to verify", () =>
        first(
          "SELECT id FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'reverify'",
          id,
        ),
      );
      await runStage(w, id, "verify", () => verifyPass);
      await itemStatus(id, "done");
    }
    expect(await merges(a)).toHaveLength(1);
    expect(await merges(b)).toHaveLength(1);
    expect((await github.state(w.repo)).pulls.every((p) => p.state === "merged")).toBe(true);
  });

  it("an updated head that fails its own verification goes back to build, not merged", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Breaks with main", files("src/a.ts"));
    await github.push(w.repo, "main", undefined, ["src/api.ts"]);
    await approve(w, a);
    const ended = await waitFor("sent to verify", () =>
      first<{ pending_action_id: string }>(
        "SELECT pending_action_id FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'reverify'",
        a,
      ),
    );
    await runStage(w, a, "verify", () => verifyFail);
    await runStage(w, a, "build", () => build(["src/a-fixed.ts"]));
    expect(await merges(a)).toHaveLength(0);
    await ok("workItem.cancel", { workItemId: a, reason: "end of test" }, w.human);
    // The carried approval never merged anything and dies with the item.
    const approval = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      ended.pending_action_id,
    );
    expect(approval?.status).toBe("rejected");
  });

  // With #73 the project's checks are what proves a head: a head no build ran on runs them again.
  it("re-verifying the new head runs the project's checks there before the approval carries", async () => {
    const w = await world({ ...BALANCED, checks: [{ name: "tests", run: "pnpm test" }] });
    const a = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Checked again" },
      w.human,
    ).then((r) => r.workItemId);
    await runStage(w, a, "triage", () => triage("small"));
    await runStage(w, a, "build", () => ({
      ...build(["src/a.ts"]),
      checks: [{ name: "tests", exitCode: 0 }],
    }));
    await runStage(w, a, "verify", (j) => {
      expect(j.checks).toBeUndefined(); // the build's results prove the built head
      return verifyPass;
    });
    await gateOpen(a, "merge");
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await approve(w, a);
    const ended = await waitFor("sent to verify", () =>
      first<{ head_sha: string }>(
        "SELECT head_sha FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'reverify'",
        a,
      ),
    );
    await runStage(w, a, "verify", (j) => {
      expect(j.checks?.commands.map((c) => c.name)).toEqual(["tests"]);
      return { ...verifyPass, checks: [{ name: "tests", exitCode: 0, headSha: ended.head_sha }] };
    });
    await itemStatus(a, "done");
    const ran = await first<{ name: string }>(
      "SELECT name FROM core_check_results WHERE work_item_id = ? AND head_sha = ?",
      a,
      ended.head_sha,
    );
    expect(ran?.name).toBe("tests");
  });

  it("a carried approval re-enters only for the change it approved", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Carried, then changed", files("src/a.ts"));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await approve(w, a);
    const ended = await waitFor("reverify", () =>
      first<{ head_sha: string; pending_action_id: string; approved_digest: string }>(
        "SELECT head_sha, pending_action_id, approved_digest FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'reverify'",
        a,
      ),
    );
    // The recorded digest no longer matches (as if the change had moved): enter refuses it.
    await env.DB.prepare(
      "UPDATE core_merge_queue SET approved_digest = 'not-the-change' WHERE work_item_id = ?",
    )
      .bind(a)
      .run();
    await expect(
      call(
        "mergeQueue.enter",
        {
          workItemId: a,
          headSha: ended.head_sha,
          pendingActionId: ended.pending_action_id,
          driver: "babysitter",
        },
        FOREMAN,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/not the one approved/),
    });
  });

  // Review of #105 (1): the same lines in a different file version hashed the same; a file both
  // sides changed now withdraws, and the item verifies the new head before a person decides again.
  it("is withdrawn when main changed a file the PR changed and GitHub gives no patch for it (binary, too large); the item verifies the new head again", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Both sides", files("src/a.ts"));
    await github.push(w.repo, "main", undefined, ["src/a.ts"]);
    await approve(w, a);
    const ended = await expectWithdrawn(w, a);
    expect(ended.end_reason).toMatch(/src\/a\.ts|not the one approved/);
    // v12: back to verify on the new head (no build), then the merge gate, then it lands.
    await runStage(w, a, "verify", (job) => {
      expect(job.harness.prompt).toContain(ended.head_sha);
      return verifyPass;
    });
    await gateOpen(a, "merge");
    await approve(w, a);
    await itemStatus(a, "done");
    expect(await merges(a)).toHaveLength(1);
  });

  // Work item #61 (2026-11-13): both sides changed one file in different hunks, GitHub's
  // update-branch merged it cleanly (its content is neither side's), and the approval was
  // withdrawn every time, in a loop. The PR's own change is identical, so it survives: the new
  // head is verified again and lands with no second approval.
  it("#61: a clean merge of main into other hunks of a file the PR changed keeps the approval, re-verifies and lands", async () => {
    const w = await world();
    const path = "apps/desktop/screenshots/fixtures.ts";
    const mine = "@@ -10,3 +10,4 @@\n ctx\n+  item: the PR's line,\n ctx";
    const a = await toMergeGateWith(w, "#61 shape", [{ path, status: "modified", patch: mine }]);
    // Main changes the same file elsewhere (another desktop PR landing).
    await github.push(w.repo, "main", undefined, [
      { path, status: "modified", patch: "@@ -500,3 +500,4 @@\n ctx\n+  main: another PR,\n ctx" },
    ]);
    await approve(w, a);
    const ended = await waitFor("reverify, not withdrawn", () =>
      first<{ outcome: string; head_sha: string; end_reason: string }>(
        "SELECT outcome, head_sha, end_reason FROM core_merge_queue WHERE work_item_id = ? AND status = 'left'",
        a,
      ),
    );
    expect(ended.outcome).toBe("reverify");
    expect(ended.end_reason).toMatch(/merged in cleanly and the change is the one approved/);
    await runStage(w, a, "verify", () => verifyPass);
    await itemStatus(a, "done");
    expect(await merges(a)).toHaveLength(1);
    // One approval, never withdrawn: nothing looped.
    expect(
      await all<{ decision: string }>(
        "SELECT decision FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
        a,
      ),
    ).toEqual([{ decision: "approved" }]);
  });

  it("the loop guard: an approval withdrawn twice for the same reason isn't updated a third time on its own; a person is asked, with the reason", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Keeps being withdrawn", files("src/a.ts"));
    const round = async () => {
      await github.push(w.repo, "main", undefined, ["src/a.ts"]);
      await approve(w, a);
      await waitFor("withdrawn", () =>
        first(
          "SELECT id FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'withdrawn' AND status = 'left' AND ended_at >= ?",
          a,
          new Date(Date.now() - 60_000).toISOString(),
        ),
      );
      await runStage(w, a, "verify", () => verifyPass);
      await gateOpen(a, "merge");
    };
    await round();
    await round();
    // A third time: main moves again; the head is held and a person asked, no third withdrawal.
    await github.push(w.repo, "main", undefined, ["src/a.ts"]);
    await approve(w, a);
    const held = await waitFor("held, a person asked", () =>
      first<{ hold_question_id: string | null }>(
        "SELECT hold_question_id FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued' AND hold_question_id IS NOT NULL",
        a,
      ),
    );
    const q = await first<{ prompt: string }>(
      "SELECT prompt FROM core_questions WHERE id = ?",
      held.hold_question_id,
    );
    expect(q?.prompt).toMatch(/withdrawn twice for the same reason/);
    expect(
      await all(
        "SELECT id FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' AND decision = 'withdrawn'",
        a,
      ),
    ).toHaveLength(2);
    await ok("workItem.cancel", { workItemId: a, reason: "end of test" }, w.human);
  });

  // Review of #105 (1): fail closed. A tree GitHub truncates has no digest, and no digest never
  // matches.
  it("is withdrawn when the approved change couldn't be read in full", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Too big to read", files("src/a.ts"));
    const head = await first<{ head_sha: string }>(
      "SELECT head_sha FROM core_work_items WHERE id = ?",
      a,
    );
    await github.truncateTree(w.repo, String(head?.head_sha));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await approve(w, a);
    const ended = await expectWithdrawn(w, a);
    expect(ended.end_reason).toMatch(/couldn't be read in full/);
  });

  // Review of #105 (2): only the merge the factory asked GitHub for counts.
  // Second review of #105: a change too big to read path by path doesn't carry an approval.
  it("is withdrawn when the change is past the paths the digest reads", async () => {
    const w = await world();
    const many = Array.from({ length: operations.MAX_CHANGED_PATHS + 1 }, (_, i) => `src/f${i}.ts`);
    const a = await toMergeGateWith(w, "A big change", files(...many));
    const entry = () =>
      first<{ approved_digest: string | null }>(
        "SELECT approved_digest FROM core_merge_queue WHERE work_item_id = ?",
        a,
      );
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await approve(w, a);
    await expectWithdrawn(w, a);
    expect((await entry())?.approved_digest).toBeNull();
  });

  it("withdraws a merge commit a person made, even with the right parents", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Crafted merge", files("src/a.ts"));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await github.deferUpdates(w.repo, true);
    await approve(w, a);
    await waitFor("update asked", () =>
      first(
        "SELECT 1 AS q FROM core_merge_queue WHERE work_item_id = ? AND update_from_sha IS NOT NULL",
        a,
      ),
    );
    // Someone pushes their own merge of main (parents: the approved head, main), sneaking in an edit.
    const branch = await first<{ branch: string }>(
      "SELECT branch FROM core_work_items WHERE id = ?",
      a,
    );
    await github.craftMerge(w.repo, String(branch?.branch), "main", {
      tree: { set: { "src/auth.ts": { mode: "100644", sha: "no-require-admin" } } },
    });
    const at = await ids(a);
    await deliverRepository(env, at.projectId, at.repositoryId);
    const ended = await expectWithdrawn(w, a);
    expect(ended.end_reason).toMatch(/isn't GitHub's update-branch merge/);
  });

  it("withdraws a GitHub-made merge that holds a third thing (a mode change)", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Third thing", files("src/a.ts"));
    // The queue asks GitHub for the update; a signed merge appears that changes the PR's file.
    const branch = await first<{ branch: string }>(
      "SELECT branch FROM core_work_items WHERE id = ?",
      a,
    );
    await github.setCiDefault(w.repo, CI(null));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await github.deferUpdates(w.repo, true);
    await approve(w, a);
    await waitFor("update asked", () =>
      first(
        "SELECT 1 AS q FROM core_merge_queue WHERE work_item_id = ? AND update_from_sha IS NOT NULL",
        a,
      ),
    );
    await github.craftMerge(w.repo, String(branch?.branch), "main", {
      byGitHub: true,
      tree: { set: { "src/a.ts": { mode: "100755", sha: "a-made-executable" } } },
    });
    const at = await ids(a);
    await deliverRepository(env, at.projectId, at.repositoryId);
    const ended = await expectWithdrawn(w, a);
    expect(ended.end_reason).toMatch(/beyond a merge of its two sides \(src\/a\.ts\)/);
    await github.setCiDefault(w.repo, null);
  });

  it("withdraws a merge the factory never asked for", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Unasked", files("src/a.ts"));
    await github.setCiDefault(w.repo, CI(null));
    await github.deferUpdates(w.repo, true);
    // Main hasn't moved, so the queue asks for no update; just before the merge, main moves and a
    // signed merge of it appears on the branch with no request recorded.
    const at = await ids(a);
    const branch = await first<{ branch: string }>(
      "SELECT branch FROM core_work_items WHERE id = ?",
      a,
    );
    deliverTestSeams.beforeLand = async () => {
      deliverTestSeams.beforeLand = null;
      await github.push(w.repo, "main", undefined, ["README.md"]);
      await github.craftMerge(w.repo, String(branch?.branch), "main", { byGitHub: true });
      await github.refuseNextMerge(w.repo, at.pr, "Head branch was modified");
    };
    await approve(w, a);
    const ended = await expectWithdrawn(w, a);
    expect(ended.end_reason).toMatch(/didn't ask for this merge/);
    await github.setCiDefault(w.repo, null);
  });
});

async function toMergeGateWith(
  w: World,
  title: string,
  files: Parameters<typeof build>[0],
): Promise<string> {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
  await runStage(w, item.workItemId, "triage", () => triage("small"));
  await runStage(w, item.workItemId, "build", () => build(files));
  await runStage(w, item.workItemId, "verify", () => verifyPass);
  await gateOpen(item.workItemId, "merge");
  return item.workItemId;
}
