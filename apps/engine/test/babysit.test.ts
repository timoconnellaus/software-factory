// The babysitter's `babysit` job (spec 53 §4 and §6, ADRs 0583 and 0585), through the real deliverer
// and Workflow: the deliverer wakes it only for what code can't decide, the job judges (and for a
// conflict resolves it on its run branch), and everything after that is code with its own floor.
import { env } from "cloudflare:workers";
import { BABYSITTER, FOREMAN } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { deliverRepository } from "../src/deliver/deliverer.ts";
import {
  all,
  build,
  call,
  first,
  gateHead,
  gateOpen,
  github,
  itemStatus,
  MANIFEST,
  ok,
  runStage,
  triage,
  uid,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;

const CI = (conclusion: string | null, name = "ci") => [
  {
    name,
    status: conclusion ? ("completed" as const) : ("in_progress" as const),
    conclusion,
    appSlug: "github-actions",
    url: `https://github.example/runs/${name}`,
  },
];

interface Item {
  id: string;
  pr: number;
  head: string;
  branch: string;
  projectId: string;
  repositoryId: string;
}

async function itemRow(id: string): Promise<Item> {
  const row = await first<{
    pr_number: number;
    head_sha: string;
    branch: string;
    project_id: string;
    repository_id: string;
  }>(
    "SELECT pr_number, head_sha, branch, project_id, repository_id FROM core_work_items WHERE id = ?",
    id,
  );
  return {
    id,
    pr: Number(row?.pr_number),
    head: String(row?.head_sha),
    branch: String(row?.branch),
    projectId: String(row?.project_id),
    repositoryId: String(row?.repository_id),
  };
}

async function toMergeGate(w: World, title: string, file: string): Promise<Item> {
  const created = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
  await runStage(w, created.workItemId, "triage", () => triage("small"));
  await runStage(w, created.workItemId, "build", () => build([file]));
  await runStage(w, created.workItemId, "verify", () => verifyPass);
  await gateOpen(created.workItemId, "merge");
  return itemRow(created.workItemId);
}

const approve = async (w: World, id: string) =>
  ok(
    "review.merge",
    { workItemId: id, openedFullDiff: true, headSha: await gateHead(id) },
    w.human,
  );

const babysitJob = (id: string, status = "queued") =>
  waitFor(`a ${status} babysit job`, () =>
    first<{ id: string; context: string; pool: string; prompt: string }>(
      "SELECT id, context, pool, prompt FROM core_jobs WHERE work_item_id = ? AND stage = 'babysit' AND status = ? ORDER BY created_at DESC",
      id,
      status,
    ),
  );

const fenceOf = async (item: Item) =>
  Number(
    (
      await first<{ babysit_fence: number }>(
        "SELECT babysit_fence FROM core_delivery_state WHERE key = ?",
        `${item.projectId}:${item.repositoryId}`,
      )
    )?.babysit_fence,
  );

const entry = (id: string) =>
  first<{ status: string; outcome: string | null; end_reason: string | null }>(
    "SELECT status, outcome, end_reason FROM core_merge_queue WHERE work_item_id = ? ORDER BY enqueued_at DESC",
    id,
  );

describe("the babysit job (spec 53 §4)", () => {
  it("a conflict at delivery: the job resolves it on its run branch, the approval is withdrawn, a person approves the resolution, it lands", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Conflicts with main", "src/a.ts");
    await github.push(w.repo, "main", undefined, ["src/a.ts"]);
    await github.setMergeable(w.repo, a.pr, false);
    await approve(w, a.id);

    // The deliverer can't decide a conflict: it wakes one babysit job, in the light pool, fence 1.
    const job = await babysitJob(a.id);
    expect(job.pool).toBe("light");
    expect(JSON.parse(job.context)).toMatchObject({
      reason: { kind: "conflict", workItemId: a.id },
      deliveryFence: 1,
    });
    expect(job.prompt).toMatch(/conflicts with main/);
    expect(job.prompt).toMatch(/Never push to main/);
    // The item is still in delivery while the job works: not sent back to build.
    expect(await entry(a.id)).toMatchObject({ status: "queued" });

    let resolution = "";
    await runStage(w, a.id, "babysit", async (claimed) => {
      expect(claimed.branch).toBe(`${a.branch}-run-4`);
      // What the runner host and the agent do: merge main into the run branch and resolve it.
      await github.createBranch(w.repo, claimed.branch, a.head);
      const merged = await github.craftMerge(w.repo, claimed.branch, "main", {
        tree: { set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } } },
      });
      return { headSha: merged, result: { verdict: "resolved", note: "kept both sides" } };
    });
    await github.setMergeable(w.repo, a.pr, true);
    // The resolution is the item's new head: the approval is withdrawn, verify runs on it.
    await runStage(w, a.id, "verify", (v) => {
      resolution = String(v.context.headSha);
      expect(resolution).not.toBe(a.head);
      return verifyPass;
    });
    expect((await itemRow(a.id)).head).toBe(resolution);
    // No build: the resolution is verified, not rebuilt.
    expect(
      await all("SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'", a.id),
    ).toHaveLength(1);
    const left = await first<{ outcome: string; end_reason: string }>(
      "SELECT outcome, end_reason FROM core_merge_queue WHERE work_item_id = ? AND status = 'left'",
      a.id,
    );
    expect(left?.outcome).toBe("withdrawn");
    expect(left?.end_reason).toMatch(/resolved a conflict.*review the resolution/);
    // The job is closed; the next reason would start a new one.
    const state = await first<{ babysit_job_id: string | null }>(
      "SELECT babysit_job_id FROM core_delivery_state WHERE key = ?",
      `${a.projectId}:${a.repositoryId}`,
    );
    expect(state?.babysit_job_id).toBeNull();

    await gateOpen(a.id, "merge");
    await approve(w, a.id);
    await itemStatus(a.id, "done");
  });

  it("a check failed after approval: one job, judged a flake, rerun once (a second rerun is refused), passes, recorded, lands", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Flaky at the merge", "src/a.ts");
    // CI on the approved head went red after verify (a flaky test).
    await github.setChecks(w.repo, a.head, CI("failure"));
    await github.setCheckDetail(
      w.repo,
      `ci-${a.head.slice(0, 6)}-0`,
      "Error: connect ECONNRESET 127.0.0.1:5432\n  at test/db.test.ts:41",
    );
    await approve(w, a.id);

    const job = await babysitJob(a.id);
    expect(JSON.parse(job.context).reason).toMatchObject({ kind: "check-failed", checks: ["ci"] });
    expect(job.prompt).toMatch(/ECONNRESET/);
    await runStage(w, a.id, "babysit", () => ({
      result: { verdict: "flake", check: "ci", test: "db connects", note: "a connection reset" },
    }));
    await waitFor("the rerun asked", async () =>
      ((await github.state(w.repo)).reruns ?? []).length > 0 ? true : null,
    );
    // Once per check per SHA, in code.
    const again = call(
      "ci.rerun",
      { workItemId: a.id, headSha: a.head, check: "ci", deliveryFence: await fenceOf(a) },
      BABYSITTER,
    );
    await expect(again).rejects.toMatchObject({ code: "conflict" });
    expect(await entry(a.id)).toMatchObject({ status: "queued" });

    // The rerun passes: a known flake, and the merge goes ahead.
    await github.setChecks(w.repo, a.head, CI("success"));
    await deliverRepository(env, a.projectId, a.repositoryId);
    await itemStatus(a.id, "done");
    const flakes = await all<{ check_name: string; test_name: string; head_sha: string }>(
      "SELECT check_name, test_name, head_sha FROM core_flakes WHERE repository_id = ?",
      a.repositoryId,
    );
    expect(flakes).toEqual([{ check_name: "ci", test_name: "db connects", head_sha: a.head }]);
  });

  it("a regression: the delivery ends failed with the job's note, and the item goes back to build", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Broken at the merge", "src/a.ts");
    await github.setChecks(w.repo, a.head, CI("failure"));
    await approve(w, a.id);
    await babysitJob(a.id);
    await runStage(w, a.id, "babysit", () => ({
      result: { verdict: "regression", check: "ci", note: "src/a.ts breaks the API test" },
    }));
    await runStage(w, a.id, "build", (b) => {
      expect(b.harness.prompt).toMatch(/judged it a regression: src\/a.ts breaks the API test/);
      return build(["src/a-fixed.ts"]);
    });
    expect(await entry(a.id)).toMatchObject({ status: "left", outcome: "failed" });
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("a job that dies is replaced by one with a higher fence; the dead job's late writes are refused", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Its babysitter dies", "src/a.ts");
    await github.push(w.repo, "main", undefined, ["src/a.ts"]);
    await github.setMergeable(w.repo, a.pr, false);
    await approve(w, a.id);
    const dead = await babysitJob(a.id);
    const claimed = await ok<{ job: { jobId: string; lease: { fencingToken: number } } | null }>(
      "job.claim",
      {
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 4, inUse: 0, accepting: true },
      },
      w.runnerActor,
    );
    expect(claimed.job?.jobId).toBe(dead.id);
    // The lease expires (runner gone): the reaper fails the run.
    await ok("run.expire", { jobId: dead.id, reason: "lease expired" }, FOREMAN);
    const fresh = await babysitJob(a.id);
    expect(fresh.id).not.toBe(dead.id);
    expect(JSON.parse(fresh.context)).toMatchObject({ deliveryFence: 2, reason: { attempt: 2 } });
    // The dead job's late hand-back is fenced, and a write with its fence is refused.
    await expect(
      call(
        "run.handBack",
        {
          jobId: dead.id,
          fencingToken: claimed.job?.lease.fencingToken,
          outcome: "completed",
          artifactIds: [],
          branch: `${a.branch}-run-4`,
          result: { verdict: "resolved", note: "late" },
        },
        w.runnerActor,
      ),
    ).rejects.toMatchObject({ code: "fenced" });
    await expect(
      call("babysit.next", { workItemId: a.id, deliveryFence: 1 }, BABYSITTER),
    ).rejects.toMatchObject({ code: "fenced" });
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("only the babysitter wakes a job, and never for an attached PR's conflict (decision 8)", async () => {
    const w = await world();
    const branch = `tim/${uid("b")}`;
    const pr = await github.openOutsidePull(w.repo, { branch, title: "Docs", body: "Docs." });
    const attached = await ok<{ workItemId: string }>(
      "workItem.attachPr",
      { projectId: w.projectId, prNumber: pr.number },
      w.human,
    );
    const item = await itemRow(attached.workItemId);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO core_delivery_state (key, project_id, repository_id, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(`${item.projectId}:${item.repositoryId}`, item.projectId, item.repositoryId, "x")
      .run();
    const reason = { kind: "conflict", headSha: pr.headSha };
    await expect(
      call("babysit.wake", { workItemId: item.id, reason }, BABYSITTER),
    ).rejects.toMatchObject({ code: "forbidden", message: /goes back to its author/ });
    await expect(
      call("babysit.wake", { workItemId: item.id, reason }, FOREMAN),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the known-flake list (decision 3)", () => {
  it("a check that flakes three times in 14 days opens one backlog item to fix it", async () => {
    const w = await world();
    const created = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Hosts the flakes" },
      w.human,
    );
    await runStage(w, created.workItemId, "triage", () => triage("small"));
    const item = await itemRow(created.workItemId);
    const key = `${item.projectId}:${item.repositoryId}`;
    await env.DB.prepare(
      "INSERT INTO core_delivery_state (key, project_id, repository_id, updated_at, babysit_fence) VALUES (?, ?, ?, ?, 3)",
    )
      .bind(key, item.projectId, item.repositoryId, new Date().toISOString())
      .run();
    const record = async (headSha: string) => {
      await env.DB.prepare(
        "INSERT INTO core_ci_reruns (repository_id, head_sha, check_name, work_item_id, test_name, asked_at) VALUES (?, ?, 'e2e', ?, 'logs in', ?)",
      )
        .bind(item.repositoryId, headSha, item.id, new Date().toISOString())
        .run();
      return ok<{ fixWorkItemId: string | null }>(
        "flake.record",
        { workItemId: item.id, headSha, check: "e2e", deliveryFence: 3 },
        BABYSITTER,
      );
    };
    expect((await record("a".repeat(40))).fixWorkItemId).toBeNull();
    expect((await record("b".repeat(40))).fixWorkItemId).toBeNull();
    const third = await record("c".repeat(40));
    expect(third.fixWorkItemId).toMatch(/^wi_/);
    const fix = await first<{ title: string; status: string; repository_id: string }>(
      "SELECT title, status, repository_id FROM core_work_items WHERE id = ?",
      third.fixWorkItemId,
    );
    expect(fix).toEqual({
      title: "Fix the flaky check e2e",
      status: "backlog",
      repository_id: item.repositoryId,
    });
    // While it is open, a fourth flake doesn't open a second.
    expect((await record("d".repeat(40))).fixWorkItemId).toBeNull();
    // Only with no rerun waiting, and only with the current fence.
    await expect(
      call(
        "flake.record",
        { workItemId: item.id, headSha: "a".repeat(40), check: "e2e", deliveryFence: 3 },
        BABYSITTER,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      call(
        "flake.record",
        { workItemId: item.id, headSha: "e".repeat(40), check: "e2e", deliveryFence: 2 },
        BABYSITTER,
      ),
    ).rejects.toMatchObject({ code: "fenced" });
    await ok("workItem.cancel", { workItemId: item.id, reason: "end of test" }, w.human);
  });
});
