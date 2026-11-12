// The babysitter's deliverer (spec 53, ADR 0580, 0585): from Workflow v11 an approval only says the
// head may merge; the engine's per-repository pass lands it. merge-queue.test.ts covers the queue's
// behaviour (order, update, CI, conflict, red CI, cancel), now run by the deliverer; this file covers
// what is the deliverer's own: who lands it, the outcome read back, and one pass at a time.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deliverRepository } from "../src/deliver/deliverer.ts";
import {
  all,
  build,
  first,
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

const approve = (w: World, workItemId: string) =>
  ok("review.merge", { workItemId, openedFullDiff: true }, w.human);

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
    const repositoryId = item?.repository_id ?? null;
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
});

describe("the approval across a merge of main (ADR 0582)", () => {
  const patched = (path: string) => [
    { path, status: "added" as const, patch: `@@ -0,0 +1 @@\n+export const x = "${path}";` },
  ];

  it("survives a clean merge that leaves the change as approved", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Same change", patched("src/a.ts"));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await approve(w, a);
    await itemStatus(a, "done");
    const entry = await first<{ approved_digest: string | null; head_sha: string }>(
      "SELECT approved_digest, head_sha FROM core_merge_queue WHERE work_item_id = ?",
      a,
    );
    expect(entry?.approved_digest).toMatch(/^[0-9a-f]{64}$/);
    const packet = await first<{ sections: string }>(
      "SELECT sections FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
      a,
      String(entry?.head_sha),
    );
    expect(JSON.parse(String(packet?.sections)).changeDigest).toMatchObject({ changed: false });
  });

  it("is withdrawn when the change differs, and a person decides again on the new head", async () => {
    const w = await world();
    const a = await toMergeGateWith(w, "Changed change", patched("src/a.ts"));
    await github.push(w.repo, "main", undefined, ["README.md"]);
    // Hold the update until the approved digest is replaced: as if merging main in had changed the
    // lines the PR adds (the fake's merges never do).
    await github.deferUpdates(w.repo, true);
    await approve(w, a);
    await waitFor("A queued", () =>
      first("SELECT 1 AS q FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued'", a),
    );
    await env.DB.prepare(
      "UPDATE core_merge_queue SET approved_digest = ? WHERE work_item_id = ? AND status = 'queued'",
    )
      .bind("0".repeat(64), a)
      .run();
    await github.deferUpdates(w.repo, false);
    const pr = await first<{ pr_number: number }>(
      "SELECT pr_number FROM core_work_items WHERE id = ?",
      a,
    );
    await github.completeUpdate(w.repo, Number(pr?.pr_number));
    // The deliverer sees the update on its next look; the cron's look, done here directly.
    const row = await first<{ project_id: string; repository_id: string | null }>(
      "SELECT project_id, repository_id FROM core_work_items WHERE id = ?",
      a,
    );
    await deliverRepository(env, String(row?.project_id), row?.repository_id ?? null);

    const ended = await waitFor("withdrawn", () =>
      first<{ outcome: string; head_sha: string; approved_sha: string }>(
        "SELECT outcome, head_sha, approved_sha FROM core_merge_queue WHERE work_item_id = ? AND outcome = 'withdrawn'",
        a,
      ),
    );
    expect(ended.head_sha).not.toBe(ended.approved_sha);
    // Back at the merge gate, on the new head, with nothing merged.
    await waitFor("a new merge gate", () =>
      first(
        "SELECT 1 AS g FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' AND status = 'pending' AND json_extract(input, '$.headSha') = ?",
        a,
        ended.head_sha,
      ),
    );
    expect(await merges(a)).toHaveLength(0);
    await approve(w, a);
    await itemStatus(a, "done");
    expect(await merges(a)).toHaveLength(1);
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
