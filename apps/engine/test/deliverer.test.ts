// The babysitter's deliverer (spec 53, ADR 0580, 0585): from Workflow v11 an approval only says the
// head may merge; the engine's per-repository pass lands it. merge-queue.test.ts covers the queue's
// behaviour (order, update, CI, conflict, red CI, cancel), now run by the deliverer; this file covers
// what is the deliverer's own: who lands it, the outcome read back, and one pass at a time.

import { env } from "cloudflare:workers";
import { BABYSITTER, FOREMAN } from "@software-factory/core";
import { afterEach, describe, expect, it } from "vitest";
import { deliverRepository, deliverTestSeams } from "../src/deliver/deliverer.ts";
import { mobileTestSeams } from "../src/mobile.ts";
import {
  all,
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
    const a = await toMergeGate(w, "Raced", "src/a.ts");
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await github.setCiDefault(w.repo, CI(null));
    await approve(w, a);
    const updated = await waitFor("A brought up to date", () =>
      first<{ head_sha: string; project_id: string }>(
        "SELECT head_sha, project_id FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued' AND head_sha != approved_sha",
        a,
      ),
    );
    // CI turns green on the updated head, with no webhook: two passes start at once.
    await github.setCiDefault(w.repo, null);
    await github.setChecks(w.repo, updated.head_sha, CI("success"));
    const item = await first<{ repository_id: string | null }>(
      "SELECT repository_id FROM core_work_items WHERE id = ?",
      a,
    );
    const repositoryId = String(item?.repository_id);
    await Promise.all([
      deliverRepository(env, updated.project_id, repositoryId),
      deliverRepository(env, updated.project_id, repositoryId),
    ]);
    await itemStatus(a, "done");
    expect(await merges(a)).toHaveLength(1);
    const state = await first<{ running_until: string | null }>(
      "SELECT running_until FROM core_delivery_state WHERE project_id = ?",
      updated.project_id,
    );
    expect(state?.running_until).toBeNull();
  });

  afterEach(() => {
    deliverTestSeams.beforeMark = null;
    deliverTestSeams.beforeLand = null;
    mobileTestSeams.beforeCommit = null;
  });

  /** A at its merge gate, approved, brought up to date with a moved main, CI pending there. */
  async function updatedAndWaiting(w: World, title: string) {
    const a = await toMergeGate(w, title, "src/a.ts");
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await github.setCiDefault(w.repo, CI(null));
    await approve(w, a);
    const updated = await waitFor("A brought up to date", () =>
      first<{ head_sha: string; project_id: string; pending_action_id: string }>(
        "SELECT head_sha, project_id, pending_action_id FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued' AND head_sha != approved_sha",
        a,
      ),
    );
    const item = await first<{ repository_id: string; pr_number: number }>(
      "SELECT repository_id, pr_number FROM core_work_items WHERE id = ?",
      a,
    );
    await github.setCiDefault(w.repo, null);
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
  it("re-snapshots a merge GitHub refused because main moved: updates again and lands", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Main moved under the merge");
    await github.setChecks(w.repo, u.head_sha, CI("success"));
    deliverTestSeams.beforeLand = async () => {
      deliverTestSeams.beforeLand = null;
      await github.push(w.repo, "main", undefined, ["CHANGELOG.md"]);
      await github.refuseNextMerge(w.repo, u.pr, "Base branch was modified");
    };
    await deliverRepository(env, u.project_id, u.repositoryId);
    const again = await waitFor("updated again", () =>
      first<{ head_sha: string; updates: number }>(
        "SELECT head_sha, updates FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued' AND head_sha != ?",
        u.a,
        u.head_sha,
      ),
    );
    expect(again.updates).toBe(2);
    await github.setChecks(w.repo, again.head_sha, CI("success"));
    await deliverRepository(env, u.project_id, u.repositoryId);
    await itemStatus(u.a, "done");
    expect(await merges(u.a)).toHaveLength(1);
  });

  // Main's pr.merge closes an approval when GitHub says the head moved; on a v11 item the
  // babysitter owns that: pr.merge leaves the approval and says why in details, not only in text.
  it("a head that moves under the babysitter's merge: pr.merge leaves the approval to it, and it re-snapshots", async () => {
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
    // Not closed behind the babysitter's back: pr.merge didn't withdraw it for the new commit.
    const approval = await first<{ status: string; note: string | null }>(
      "SELECT status, note FROM core_pending_actions WHERE id = ?",
      u.pending_action_id,
    );
    expect(approval?.note ?? "").not.toMatch(/review the new commit/);
    // The deliverer matched the refusal by its details and re-snapshotted: the snapshot, not
    // pr.merge's text, decided what happens to the moved head.
    const ended = await first<{ end_reason: string | null }>(
      "SELECT end_reason FROM core_merge_queue WHERE work_item_id = ? ORDER BY enqueued_at DESC LIMIT 1",
      u.a,
    );
    expect(ended?.end_reason ?? "").not.toMatch(/pr\.merge failed after approval/);
    expect(ended?.end_reason ?? "").toMatch(/moved/);
    expect(await merges(u.a)).toEqual([]);
  });

  it("asks GitHub to update a head at most MAX_UPDATES times, then holds it", async () => {
    const w = await world();
    const u = await updatedAndWaiting(w, "Main keeps moving");
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
    await itemStatus(u.a, "done");
    const entry = await first<{ updates: number; status: string }>(
      "SELECT updates, status FROM core_merge_queue WHERE work_item_id = ?",
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
