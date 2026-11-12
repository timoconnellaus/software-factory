// Stop the line (spec 53, ADR 0581): while a repository's default branch is red, the babysitter
// lands only repairs; every other approved item is held, visibly, until main is green again.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { BABYSITTER, type CheckRunInfo } from "@software-factory/core";
import { afterEach, describe, expect, it } from "vitest";
import { deliverRepository } from "../src/deliver/deliverer.ts";
import worker from "../src/index.ts";
import { mobileTestSeams } from "../src/mobile.ts";
import {
  all,
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

/** Calls an operation as the test's person, from another surface. */
async function invokeFrom(surface: "cli", op: string, input: unknown, w: World) {
  const { invoke } = await import("@software-factory/core");
  const { invokeDeps } = await import("../src/deps.ts");
  return invoke(invokeDeps(env), op, input, { actor: w.human, origin: { surface } });
}

// With the times GitHub gives, so observations order as they would (now: later than any earlier).
const CI = (conclusion: string) => [
  {
    name: "ci",
    status: "completed" as const,
    conclusion,
    appSlug: "github-actions",
    url: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
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
    const inbox = await ok<{ mainRed: { projectId: string; failing: string[] }[] }>(
      "inbox.list",
      {},
      w.human,
    );
    expect(inbox.mainRed.find((c) => c.projectId === w.projectId)).toMatchObject({
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
    // CI on main's next head (B's merge) hasn't reported yet.
    await github.setCiDefault(w.repo, [
      { ...CI("success")[0], status: "in_progress", conclusion: null },
    ] as never);
    await approve(w, b);
    await itemStatus(b, "done");
    // A is still held: B's merge is a new head on main whose CI hasn't said green yet.
    expect(await queued(a)).toMatchObject({ status: "queued" });

    await github.setCiDefault(w.repo, null);
    const head = String(await github.getBranchSha(w.repo, "main"));
    await mainCi(w, head, "success");
    await itemStatus(a, "done");
  });

  afterEach(() => {
    mobileTestSeams.beforeCommit = null;
  });

  const run = (
    conclusion: string | null,
    startedAt: string | null,
    completedAt: string | null,
  ): CheckRunInfo[] => [
    {
      id: uid("run-"),
      name: "ci",
      status: conclusion ? "completed" : "in_progress",
      conclusion,
      appSlug: "github-actions",
      url: null,
      startedAt,
      completedAt,
    },
  ];
  const observe = (w: World) =>
    ok<{ state: string; changed: boolean; redSince: string | null }>(
      "main.observe",
      { repo: { owner: w.repo.owner, name: w.repo.repo }, headSha: null, trigger: "recheck" },
      BABYSITTER,
    );
  const health = (w: World) =>
    first<{ state: string; head_sha: string; red_since: string | null }>(
      "SELECT state, head_sha, red_since FROM core_main_health WHERE project_id = ?",
      w.projectId,
    );
  const t = (s: number) => new Date(Date.UTC(2020, 0, 1, 10, 0, s)).toISOString();

  // Review of #104 (1): one missed green webhook must not keep the line stopped until a push.
  it("the held recheck reads main from GitHub: a missed green webhook costs one recheck", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Held, then the webhook is lost", "src/a.ts");
    const red = String(await github.getBranchSha(w.repo, "main"));
    await mainCi(w, red, "failure");
    await approve(w, a);
    await waitFor("A queued", () => queued(a));
    // Main goes green on GitHub, and the webhook never arrives.
    await github.setChecks(w.repo, red, CI("success"));
    const item = await first<{ repository_id: string }>(
      "SELECT repository_id FROM core_work_items WHERE id = ?",
      a,
    );
    await deliverRepository(env, w.projectId, String(item?.repository_id));
    await itemStatus(a, "done");
    expect((await health(w))?.state).toBe("green");
  });

  // Review of #104 (2): observations are ordered by GitHub's own times, guarded in SQL.
  it("an older observation committing late never overwrites a newer one (same head)", async () => {
    const w = await world();
    const head = String(await github.getBranchSha(w.repo, "main"));
    await github.setChecks(w.repo, head, run("failure", t(0), t(10)));
    // A reads red, and is held just before its batch commits.
    let releaseA: () => void = () => {};
    const aHeld = new Promise<void>((r) => {
      releaseA = r;
    });
    let reached: () => void = () => {};
    const aAtCommit = new Promise<void>((r) => {
      reached = r;
    });
    mobileTestSeams.beforeCommit = async (op) => {
      if (op !== "main.observe") return;
      mobileTestSeams.beforeCommit = null;
      reached();
      await aHeld;
    };
    const a = observe(w).catch((e: unknown) => e);
    await aAtCommit;
    // Meanwhile a rerun passes and B records green.
    await github.setChecks(w.repo, head, run("success", t(20), t(30)));
    expect((await observe(w)).state).toBe("green");
    releaseA();
    expect(await a).toMatchObject({ code: "conflict" });
    expect((await health(w))?.state).toBe("green");
  });

  it("a read of an older head committing late never overwrites the newer head", async () => {
    const w = await world();
    const h1 = String(await github.getBranchSha(w.repo, "main"));
    await github.setChecks(w.repo, h1, run("failure", t(0), t(10)));
    let releaseA: () => void = () => {};
    const aHeld = new Promise<void>((r) => {
      releaseA = r;
    });
    let reached: () => void = () => {};
    const aAtCommit = new Promise<void>((r) => {
      reached = r;
    });
    mobileTestSeams.beforeCommit = async (op) => {
      if (op !== "main.observe") return;
      mobileTestSeams.beforeCommit = null;
      reached();
      await aHeld;
    };
    const a = observe(w).catch((e: unknown) => e);
    await aAtCommit;
    // main moves on (a later commit), green there, recorded first.
    const h2 = await github.push(w.repo, "main", undefined, ["src/next.ts"]);
    await github.setChecks(w.repo, h2, run("success", t(5), t(6)));
    expect((await observe(w)).state).toBe("green");
    releaseA();
    expect(await a).toMatchObject({ code: "conflict" });
    expect(await health(w)).toMatchObject({ state: "green", head_sha: h2 });
  });

  it("counts a cancelled or timed-out run as red, ignores one cancelled before it started", async () => {
    const w = await world();
    const head = String(await github.getBranchSha(w.repo, "main"));
    await github.setChecks(w.repo, head, run("cancelled", null, t(1)));
    expect((await observe(w)).state).toBe("pending"); // superseded before it started: no CI yet
    await github.setChecks(w.repo, head, run("timed_out", t(2), t(60)));
    expect((await observe(w)).state).toBe("red");
    const h2 = await github.push(w.repo, "main", undefined, ["src/c.ts"]);
    await github.setChecks(w.repo, h2, run("cancelled", t(70), t(80)));
    const seen = await observe(w);
    expect(seen.state).toBe("red");
    expect(seen.redSince).not.toBeNull();
  });

  it("a rerun in flight keeps the episode open; its green closes it; flapping opens a new one", async () => {
    const w = await world();
    const head = String(await github.getBranchSha(w.repo, "main"));
    await github.setChecks(w.repo, head, run("failure", t(0), t(10)));
    const first1 = await observe(w);
    expect(first1.state).toBe("red");
    // A rerun starts (GitHub lists the latest attempt): pending, still stopped.
    await github.setChecks(w.repo, head, run(null, t(20), null));
    const pending = await observe(w);
    expect(pending).toMatchObject({ state: "pending", redSince: first1.redSince });
    await github.setChecks(w.repo, head, run("success", t(20), t(30)));
    expect((await observe(w)).redSince).toBeNull();
    // Flaps red again: a new episode, told to the project's approvers (not everyone).
    const again = await observe(w);
    expect(again.state).toBe("green");
    await github.setChecks(w.repo, head, run("failure", t(40), t(50)));
    const second = await observe(w);
    expect(second.redSince).not.toBeNull();
    expect(second.redSince).not.toBe(first1.redSince);
    const row = await first<{ audience: string }>(
      "SELECT audience FROM core_main_health WHERE project_id = ?",
      w.projectId,
    );
    expect(JSON.parse(String(row?.audience))).toEqual([w.human.id]);
  });

  // Review of #104 (4): an observation that changes nothing writes nothing, not even an audit row.
  it("writes an audit row only when main's state changes", async () => {
    const w = await world();
    const head = String(await github.getBranchSha(w.repo, "main"));
    await github.setChecks(w.repo, head, run("failure", t(0), t(10)));
    await observe(w);
    await observe(w);
    await mainCi(w, head, "failure");
    const rows = await all<{ outcome: string }>(
      "SELECT outcome FROM core_audit WHERE operation = 'main.observe' AND project_id = ?",
      w.projectId,
    );
    expect(rows).toEqual([{ outcome: "ok" }]);
  });

  // Review of #104 (3): a repair is for a red main only, confirmed like a gate decision.
  it("markRepair needs a stopped line, a person in the browser, and sorts first only while red", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Ordinary", "src/a.ts");
    const b = await toMergeGate(w, "The fix", "src/b.ts");
    await expect(
      call("workItem.markRepair", { workItemId: b, repair: true }, w.human),
    ).rejects.toMatchObject({ code: "conflict" });
    const red = String(await github.getBranchSha(w.repo, "main"));
    await mainCi(w, red, "failure");
    // Not from the CLI (or MCP): browser-only, a device needs a presence proof.
    await expect(
      invokeFrom("cli", "workItem.markRepair", { workItemId: b, repair: true }, w),
    ).rejects.toMatchObject({ code: "forbidden" });
    await ok("workItem.markRepair", { workItemId: b, repair: true }, w.human);
    // Both approved; B's update gets pending CI so both stay queued.
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await github.setCiDefault(w.repo, run(null, t(0), null));
    await approve(w, a);
    await approve(w, b);
    await waitFor("both queued", async () => ((await queued(a)) && (await queued(b))) || null);
    const order = async () =>
      (
        await ok<{ entries: { workItemId: string }[] }>(
          "mergeQueue.list",
          { projectId: w.projectId },
          w.human,
        )
      ).entries.map((e) => e.workItemId);
    expect(await order()).toEqual([b, a]);
    // Green again: a repair is just another item; approval order holds.
    const head = String(await github.getBranchSha(w.repo, "main"));
    await github.setChecks(w.repo, head, CI("success"));
    await mainCi(w, head, "success");
    expect(await order()).toEqual([a, b]);
  });
});
