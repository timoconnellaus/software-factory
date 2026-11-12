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
