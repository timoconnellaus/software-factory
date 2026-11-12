// Stop the line (spec 53, ADR 0581): while a repository's default branch is red, the babysitter
// lands only repairs; every other approved item is held, visibly, until main is green again.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
  build,
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

const CI = (conclusion: string) => [
  {
    name: "ci",
    status: "completed" as const,
    conclusion,
    appSlug: "github-actions",
    url: null,
  },
];

async function webhook(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await worker.fetch(
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
  expect(res.status).toBe(200);
}

/** Main's CI settles on `sha` with `conclusion`, and GitHub says so. */
async function mainCi(w: World, sha: string, conclusion: string) {
  await github.setChecks(w.repo, sha, CI(conclusion));
  await webhook("check_suite", {
    action: "completed",
    repository: { name: w.repo.repo, owner: { login: w.repo.owner }, default_branch: "main" },
    check_suite: {
      head_sha: sha,
      head_branch: "main",
      status: "completed",
      app: { slug: "github-actions" },
    },
  });
}

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

const queued = (workItemId: string) =>
  first<{ status: string }>(
    "SELECT status FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued'",
    workItemId,
  );

describe("stop the line (spec 53)", () => {
  it("holds approved work while main is red, says so, and lands it when main is green", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Held behind red main", "src/a.ts");
    const red = String(await github.getBranchSha(w.repo, "main"));
    await mainCi(w, red, "failure");
    const health = await first<{ state: string; red_since: string | null; first_red_sha: string }>(
      "SELECT state, red_since, first_red_sha FROM core_main_health WHERE project_id = ?",
      w.projectId,
    );
    expect(health).toMatchObject({ state: "red", first_red_sha: red });
    expect(health?.red_since).not.toBeNull();

    await approve(w, a);
    await waitFor("A queued", () => queued(a));
    // The deliverer ran (enter wakes it) and held A: nothing merged, nothing updated.
    const pos = await ok<{ queued: boolean; held: { failing: string[] } | null }>(
      "mergeQueue.position",
      { workItemId: a },
      w.human,
    );
    expect(pos.held).toMatchObject({ failing: ["ci"] });
    expect((await github.state(w.repo)).pulls.every((p) => p.state === "open")).toBe(true);
    const status = await ok<{
      repositories: { main: { state: string } | null; deliveries: { state: string }[] }[];
    }>("delivery.status", { projectId: w.projectId }, w.human);
    expect(status.repositories[0]?.main?.state).toBe("red");
    expect(status.repositories[0]?.deliveries.map((d) => d.state)).toEqual(["held"]);
    const inbox = await ok<{ mainRed: { projectId: string; held: number; failing: string[] }[] }>(
      "inbox.list",
      {},
      w.human,
    );
    expect(inbox.mainRed.find((c) => c.projectId === w.projectId)).toMatchObject({
      held: 1,
      failing: ["ci"],
    });

    // Someone fixes main outside the queue; its CI is green: the line runs and A lands.
    const fixed = await github.push(w.repo, "main", undefined, ["src/fix.ts"]);
    await mainCi(w, fixed, "success");
    await itemStatus(a, "done");
    const after = await first<{ state: string; red_since: string | null; last_green_sha: string }>(
      "SELECT state, red_since, last_green_sha FROM core_main_health WHERE project_id = ?",
      w.projectId,
    );
    expect(after).toEqual({ state: "green", red_since: null, last_green_sha: fixed });
    const cleared = await ok<{ mainRed: { projectId: string }[] }>("inbox.list", {}, w.human);
    expect(cleared.mainRed.some((c) => c.projectId === w.projectId)).toBe(false);
  });

  it("lands a repair while main is red, ahead of what is held", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Ordinary change", "src/a.ts");
    const b = await toMergeGate(w, "Fix main", "src/fix.ts");
    const red = String(await github.getBranchSha(w.repo, "main"));
    await mainCi(w, red, "failure");

    await approve(w, a);
    await waitFor("A queued", () => queued(a));
    await ok("workItem.markRepair", { workItemId: b, repair: true }, w.human);
    await approve(w, b);
    await itemStatus(b, "done");
    // A is still held: B's merge is a new head on main whose CI hasn't said green yet.
    expect(await queued(a)).toMatchObject({ status: "queued" });

    const head = String(await github.getBranchSha(w.repo, "main"));
    await mainCi(w, head, "success");
    await itemStatus(a, "done");
  });
});
