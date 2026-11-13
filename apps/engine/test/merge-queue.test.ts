// The merge queue in the v4 Workflow (ADR 0330, spec 06): approved merges land one at a time per
// project. The head is brought up to date with the default branch (GitHub's update-branch), CI runs
// once on that head, then it merges; the next head is woken and does the same. A conflict or red
// CI at the head takes the item out of the queue and back to build, and the queue moves on.
//
// Every case runs twice: on v7, where the item's own Workflow lands it (`landV4`, still serving
// instances started before v11), and on v11, where the babysitter's deliverer does (spec 53). The
// behaviour is the same; only who does it differs.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKFLOW_VERSION } from "../src/workflow/work-item.ts";
import {
  build,
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

const GREEN_CI = [
  {
    name: "ci",
    status: "completed" as const,
    conclusion: "success",
    appSlug: "github-actions",
    url: null,
  },
];
const RED_CI = [{ ...GREEN_CI[0], conclusion: "failure" } as (typeof GREEN_CI)[0]];

/** Creates a work item and takes it through triage, build and verify to its merge gate. */
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
  const row = await first<{ number: number; pr_number: number; head_sha: string }>(
    "SELECT number, pr_number, head_sha FROM core_work_items WHERE id = ?",
    item.workItemId,
  );
  return { id: item.workItemId, number: Number(row?.number), pr: Number(row?.pr_number) };
}

const approve = async (w: World, workItemId: string) =>
  ok(
    "review.merge",
    { workItemId, openedFullDiff: true, headSha: await gateHead(workItemId) },
    w.human,
  );

const entry = (workItemId: string, where = "") =>
  first<{ head_sha: string; approved_sha: string; status: string; end_reason: string | null }>(
    `SELECT head_sha, approved_sha, status, end_reason FROM core_merge_queue WHERE work_item_id = ? ${where} ORDER BY enqueued_at DESC LIMIT 1`,
    workItemId,
  );

describe.each([7, 11, WORKFLOW_VERSION])("the merge queue (v%i)", (version) => {
  // v7: new instances replay as v7 (their recorded version), landing themselves with landV4.
  let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | null = null;
  beforeEach(async () => {
    if (version === WORKFLOW_VERSION) return;
    introspector = await introspectWorkflow(env.WORK_ITEM_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: "meta: version" }, version);
    });
  });
  afterEach(async () => {
    await introspector?.[Symbol.asyncDispose]();
    introspector = null;
  });

  it("records who lands the merge", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Who lands it", "src/a.ts");
    await approve(w, a.id);
    await itemStatus(a.id, "done");
    const landed = await first<{ actor_id: string }>(
      "SELECT actor_id FROM core_audit WHERE operation = 'pr.merge' AND work_item_id = ? AND outcome = 'ok'",
      a.id,
    );
    expect(landed?.actor_id).toBe(version === 7 ? "foreman" : "babysitter");
    const row = await first<{ workflow_version: number }>(
      "SELECT workflow_version FROM core_work_items WHERE id = ?",
      a.id,
    );
    expect(row?.workflow_version).toBe(version);
  });

  // v4–v10 used to carry the packet to the updated head (ADR 0330). A packet is never carried now
  // (#190 review, round 2): such an item can't verify a new head before it lands, so the queue's
  // update ends its turn and it goes back to build and verify on the new head, then lands. The
  // babysitter's deliveries (v11+) verify an updated head again instead: deliverer.test.ts.
  it.skipIf(version !== 7)(
    "lands approved merges one at a time; a head that must be updated goes back to verify on the new head first",
    async () => {
      const w = await world();
      const a = await toMergeGate(w, "First in line", "src/a.ts");
      // Someone else's change lands on main: A is now behind it.
      await github.push(w.repo, "main", undefined, ["README.md"]);
      await approve(w, a.id);
      const left = await waitFor("A updated and out of the queue", () =>
        entry(a.id, "AND status = 'left'"),
      );
      expect(left?.end_reason).toMatch(
        /moved while this was waiting to merge: main was merged in as .* verified again before it merges/,
      );
      // The queue's merge is on the branch, and no packet was carried to it.
      const item = await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        a.id,
      );
      const head = String((await github.state(w.repo)).refs[String(item?.branch)]);
      const parents = await github.commitParents(w.repo, head);
      expect(parents[0]).toBe(left?.approved_sha);
      expect(
        await first(
          "SELECT id FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
          a.id,
          head,
        ),
      ).toBeNull();
      expect((await github.state(w.repo)).pulls.every((p) => p.state === "open")).toBe(true);
      // The approval was closed; the item verifies the updated head (no build), then the gate.
      const approval = await first<{ decision: string }>(
        "SELECT decision FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' ORDER BY created_at LIMIT 1",
        a.id,
      );
      expect(approval?.decision).toBe("withdrawn");
      await runStage(w, a.id, "verify", (job) => {
        expect(job.harness.prompt).toContain(head);
        return verifyPass;
      });
      await gateOpen(a.id, "merge");
      // B, built on today's main, queues behind A and lands after it.
      const b = await toMergeGate(w, "Second in line", "src/b.ts");
      await approve(w, a.id);
      await itemStatus(a.id, "done");
      await approve(w, b.id);
      await waitFor("B in the queue", () => entry(b.id));
      const bLeft = await waitFor("B done or back", () =>
        entry(b.id, "AND status IN ('merged', 'left')"),
      );
      // B is behind A's merge now: it goes back to verify too, never lands on A's old main.
      expect(bLeft?.status).toBe("left");
      expect(bLeft?.end_reason).toMatch(/verified again before it merges/);
      await ok("workItem.cancel", { workItemId: b.id, reason: "end of test" }, w.human);
    },
  );

  // #190 review, round 3: on a busy main an item that lands itself could go round for ever (update,
  // back to verify, approve, update...). After two trips in a row it is held and the owner asked.
  it.skipIf(version !== 7)(
    "holds an item that went back to verify twice in a row, and asks the owner",
    async () => {
      const w = await world();
      const a = await toMergeGate(w, "Main keeps moving", "src/a.ts");
      const trip = async (n: number) => {
        await github.push(w.repo, "main", undefined, [`docs/elsewhere-${n}.md`]);
        await approve(w, a.id);
        await waitFor("back to verify", () =>
          entry(a.id, `AND status = 'left' AND end_reason LIKE '%moved while this was waiting%'`),
        );
        await runStage(w, a.id, "verify", () => verifyPass);
        await gateOpen(a.id, "merge");
      };
      await trip(1);
      await trip(2);
      await github.push(w.repo, "main", undefined, ["docs/elsewhere-3.md"]);
      await approve(w, a.id);
      const held = await waitFor("held, the owner asked", () =>
        first<{ hold_question_id: string | null }>(
          "SELECT hold_question_id FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued' AND hold_question_id IS NOT NULL",
          a.id,
        ),
      );
      const q = await first<{ prompt: string }>(
        "SELECT prompt FROM core_questions WHERE id = ?",
        held.hold_question_id,
      );
      expect(q?.prompt).toMatch(/moved twice in a row while #\d+ was waiting to merge/);
      expect((await github.state(w.repo)).pulls.every((p) => p.state === "open")).toBe(true);
      await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
    },
  );

  // v4–v7 carry the packet to the updated head (ADR 0330). The babysitter's deliveries (v11+) verify
  // an updated head again instead (spec 53 PR c): deliverer.test.ts covers them.
  it.skipIf(version !== 7)(
    "takes a head that conflicts out of the queue and back to build, and the next one lands",
    async () => {
      const w = await world();
      const a = await toMergeGate(w, "Conflicts at the head", "src/a.ts");
      await github.push(w.repo, "main", undefined, ["src/a.ts"]);
      await github.setMergeable(w.repo, a.pr, false);
      // Built on today's main: it needs no update, so it lands as it is.
      const b = await toMergeGate(w, "Lands meanwhile", "src/b.ts");

      await approve(w, a.id);
      await waitFor("A left the queue", () => entry(a.id, "AND status = 'left'"));
      await approve(w, b.id);
      await itemStatus(b.id, "done");

      // A goes back to build with what to do, without a spent retry (retryLimit 1, and it lands).
      await runStage(w, a.id, "build", async (job) => {
        expect(job.harness.prompt).toMatch(/can't merge into `main`/);
        // The build merges main in and resolves the conflict, as the runner host has it do.
        const row = await first<{ branch: string }>(
          "SELECT branch FROM core_work_items WHERE id = ?",
          a.id,
        );
        await github.craftMerge(w.repo, String(row?.branch), "main", {
          tree: { set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } } },
        });
        await github.setMergeable(w.repo, a.pr, true);
        return build(["src/a-merged.ts"]);
      });
      await runStage(w, a.id, "verify", () => verifyPass);
      await gateOpen(a.id, "merge");
      await approve(w, a.id);
      await itemStatus(a.id, "done");
    },
  );

  // v4–v7 carry the packet to the updated head (ADR 0330). The babysitter's deliveries (v11+) verify
  // an updated head again instead (spec 53 PR c): deliverer.test.ts covers them.
  it.skipIf(version !== 7)(
    "sends a head that main must be merged into back to verify, whatever its CI",
    async () => {
      const w = await world();
      const a = await toMergeGate(w, "Breaks with main", "src/a.ts");
      await github.push(w.repo, "main", undefined, ["src/api.ts"]);
      await github.setCiDefault(w.repo, RED_CI);
      await approve(w, a.id);
      // The update ends its turn before CI is read (#190 review): it verifies the new head, where
      // the red CI fails verify and sends it back to build as a failed attempt.
      await runStage(w, a.id, "verify", () => verifyPass);
      const left = await entry(a.id);
      expect(left).toMatchObject({ status: "left" });
      expect(left?.end_reason).toMatch(/moved while this was waiting to merge/);
      await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
    },
  );

  // v4–v7 carry the packet to the updated head (ADR 0330). The babysitter's deliveries (v11+) verify
  // an updated head again instead (spec 53 PR c): deliverer.test.ts covers them.
  it.skipIf(version !== 7)("frees the head when the item at it is cancelled", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Cancelled at the head", "src/a.ts");
    await github.push(w.repo, "main", undefined, ["README.md"]);
    // Built on today's main: it needs no update.
    const b = await toMergeGate(w, "Waits behind it", "src/b.ts");
    // GitHub's view of A's branch lags the queue's merge: A holds the head, updating.
    await github.deferUpdates(w.repo, true);
    await approve(w, a.id);
    await waitFor("A at the head, updating", () =>
      first(
        "SELECT 1 AS q FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued' AND update_merge_sha IS NOT NULL",
        a.id,
      ),
    );
    await approve(w, b.id);
    await waitFor("B queued", () => entry(b.id, "AND status = 'queued'"));
    await github.deferUpdates(w.repo, false);
    await ok("workItem.cancel", { workItemId: a.id, reason: "not needed" }, w.human);
    expect((await entry(a.id))?.status).toBe("left");
    await itemStatus(b.id, "done");
  });
});
