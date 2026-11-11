// The merge queue in the v4 Workflow (ADR 0330, spec 06): approved merges land one at a time per
// project. The head is brought up to date with the default branch (GitHub's update-branch), CI runs
// once on that head, then it merges; the next head is woken and does the same. A conflict or red
// CI at the head takes the item out of the queue and back to build, and the queue moves on.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { FOREMAN } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
  build,
  call,
  first,
  gateOpen,
  github,
  itemStatus,
  ok,
  runStage,
  triage,
  uid,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;

const PENDING_CI = [
  {
    name: "ci",
    status: "in_progress" as const,
    conclusion: null,
    appSlug: "github-actions",
    url: null,
  },
];
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

async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return worker.fetch(
    new Request("https://software-factory.example/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": uid("delivery-"),
        "x-hub-signature-256": await sign("test-webhook-secret", body),
      },
    }),
    env,
  );
}

/** Creates a work item and takes it through triage, build and verify to its merge gate. */
async function toMergeGate(w: World, title: string, file: string) {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { projectId: w.projectId, title },
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

const approve = (w: World, workItemId: string) =>
  ok("review.merge", { workItemId, openedFullDiff: true }, w.human);

const entry = (workItemId: string, where = "") =>
  first<{ head_sha: string; approved_sha: string; status: string; end_reason: string | null }>(
    `SELECT head_sha, approved_sha, status, end_reason FROM core_merge_queue WHERE work_item_id = ? ${where} ORDER BY enqueued_at DESC LIMIT 1`,
    workItemId,
  );

describe("the merge queue (v4)", () => {
  it("lands approved merges one at a time, bringing each head up to date with what landed before it", async () => {
    const w = await world();
    const a = await toMergeGate(w, "First in line", "src/a.ts");
    const b = await toMergeGate(w, "Second in line", "src/b.ts");
    // Someone else's change lands on main: both branches are now behind it.
    await github.push(w.repo, "main", undefined, ["README.md"]);
    // CI on the head A gets once main is merged in stays pending: A holds the head.
    await github.setCiDefault(w.repo, PENDING_CI);

    await approve(w, a.id);
    const aQueued = await waitFor("A brought up to date", () =>
      entry(a.id, "AND status = 'queued' AND head_sha != approved_sha"),
    );
    const aHead = aQueued.head_sha;
    // The queue's update is GitHub's merge of main into the approved head, nothing else.
    const parents = await github.commitParents(w.repo, aHead);
    expect(parents[0]).toBe(aQueued.approved_sha);
    expect((await github.compareCommits(w.repo, "main", aHead)).behindBy).toBe(0);
    // The review packet carries over to the new head (the reviewed diff is unchanged).
    const carried = await first<{ sections: string; verdict: string }>(
      "SELECT sections, verdict FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
      a.id,
      aHead,
    );
    expect(carried?.verdict).toBe("pass");
    expect(JSON.parse(String(carried?.sections)).carriedFrom).toBe(aQueued.approved_sha);

    await approve(w, b.id);
    await waitFor("B queued", () => entry(b.id, "AND status = 'queued'"));
    const pos = await ok<{ position: number; head: boolean; ahead: number[] }>(
      "mergeQueue.position",
      { workItemId: b.id },
      w.human,
    );
    expect(pos).toMatchObject({ position: 2, head: false, ahead: [a.number] });
    // Only the head is updated or merged.
    await expect(call("mergeQueue.update", { workItemId: b.id }, FOREMAN)).rejects.toMatchObject({
      code: "conflict",
    });
    const pullsWhileHeld = (await github.state(w.repo)).pulls;
    expect(pullsWhileHeld.every((p) => p.state === "open")).toBe(true);
    const list = await ok<{ entries: { number: number }[] }>(
      "mergeQueue.list",
      { projectId: w.projectId },
      w.human,
    );
    expect(list.entries.map((e) => e.number)).toEqual([a.number, b.number]);

    // CI goes green on A's head: A merges, then B is woken, updated against A's merge, and lands.
    await github.setCiDefault(w.repo, null);
    await github.setChecks(w.repo, aHead, GREEN_CI);
    await deliver("check_suite", {
      action: "completed",
      repository: { name: w.repo.repo, owner: { login: w.repo.owner } },
      check_suite: { head_sha: aHead, status: "completed", app: { slug: "github-actions" } },
    });
    await itemStatus(a.id, "done");
    await itemStatus(b.id, "done");
    expect((await entry(a.id))?.status).toBe("merged");
    const bDone = await entry(b.id);
    expect(bDone?.status).toBe("merged");
    // B's update merged in a main that already had A.
    const bParents = await github.commitParents(w.repo, String(bDone?.head_sha));
    expect((await github.compareCommits(w.repo, String(bParents[1]), aHead)).aheadBy).toBe(0);
    expect((await github.state(w.repo)).pulls.every((p) => p.state === "merged")).toBe(true);
  });

  it("takes a head that conflicts out of the queue and back to build, and the next one lands", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Conflicts at the head", "src/a.ts");
    const b = await toMergeGate(w, "Lands meanwhile", "src/b.ts");
    await github.push(w.repo, "main", undefined, ["src/a.ts"]);
    await github.setMergeable(w.repo, a.pr, false);

    await approve(w, a.id);
    await waitFor("A left the queue", () => entry(a.id, "AND status = 'left'"));
    await approve(w, b.id);
    await itemStatus(b.id, "done");

    // A goes back to build with what to do, without a spent retry (retryLimit 1, and it lands).
    await runStage(w, a.id, "build", async (job) => {
      expect(job.harness.prompt).toMatch(/can't merge into `main`/);
      await github.setMergeable(w.repo, a.pr, true);
      return build(["src/a-merged.ts"]);
    });
    await runStage(w, a.id, "verify", () => verifyPass);
    await gateOpen(a.id, "merge");
    await approve(w, a.id);
    await itemStatus(a.id, "done");
  });

  it("sends a head whose CI goes red once main is merged in back to build, as a failed attempt", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Breaks with main", "src/a.ts");
    await github.push(w.repo, "main", undefined, ["src/api.ts"]);
    await github.setCiDefault(w.repo, RED_CI);
    await approve(w, a.id);
    await runStage(w, a.id, "build", async (job) => {
      expect(job.harness.prompt).toMatch(/broke CI/);
      return build(["src/a-fixed.ts"]);
    });
    const left = await entry(a.id);
    expect(left).toMatchObject({ status: "left" });
    expect(left?.end_reason).toMatch(/CI is failure/);
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("frees the head when the item at it is cancelled", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Cancelled at the head", "src/a.ts");
    const b = await toMergeGate(w, "Waits behind it", "src/b.ts");
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await github.setCiDefault(w.repo, PENDING_CI);
    await approve(w, a.id);
    await waitFor("A at the head", () =>
      entry(a.id, "AND status = 'queued' AND head_sha != approved_sha"),
    );
    await approve(w, b.id);
    await waitFor("B queued", () => entry(b.id, "AND status = 'queued'"));
    await github.setCiDefault(w.repo, null);
    await ok("workItem.cancel", { workItemId: a.id, reason: "not needed" }, w.human);
    expect((await entry(a.id))?.status).toBe("left");
    await itemStatus(b.id, "done");
  });
});
