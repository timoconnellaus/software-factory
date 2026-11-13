// The babysitter's `babysit` job (spec 53 §4 and §6, ADRs 0583 and 0585), through the real deliverer
// and Workflow: the deliverer wakes it only for what code can't decide, the job judges (and for a
// conflict resolves it on its run branch), and everything after that is code with its own floor.
import { env } from "cloudflare:workers";
import { BABYSITTER, FOREMAN, NO_BABYSIT_RUNNER } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { deliverRepository } from "../src/deliver/deliverer.ts";
import { pruneBabysit } from "../src/index.ts";
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
    // The reopened gate shows only the resolution: the conflicted file, nothing outside it.
    const got = await ok<{
      babysitResolution: {
        sha: string;
        files: { path: string; conflicted: boolean }[];
        outside: string[];
      } | null;
    }>("workItem.get", { workItemId: a.id }, w.human);
    expect(got.babysitResolution).toMatchObject({
      sha: resolution,
      status: "clean",
      files: [{ path: "src/a.ts", conflicted: true, previousPath: null }],
      outside: [],
      notShown: 0,
      patchBase: "itemHead",
    });
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
    // No approval of any kind carries to the resolution (for PR #152's auto-approval too): the only
    // merge decision on its head is the open gate a person (or autoApprove, on the new head's own
    // evidence) decides.
    const onResolution = await all<{ status: string; decided_by: string | null }>(
      "SELECT status, decided_by FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' AND json_extract(input, '$.headSha') = ?",
      a.id,
      resolution,
    );
    expect(onResolution).toEqual([{ status: "pending", decided_by: null }]);
    expect(
      await first<{ approved_sha: string }>(
        "SELECT approved_sha FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued'",
        a.id,
      ),
    ).toBeNull();
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
    await runStage(w, a.id, "babysit", async (claimed) => {
      // It pushes nothing, so its job token is read-only.
      await ok(
        "run.issueToken",
        { jobId: claimed.jobId, fencingToken: claimed.lease.fencingToken },
        w.runnerActor,
      );
      expect((await github.state(w.repo)).readOnlyTokens).toBe(1);
      return {
        result: { verdict: "flake", check: "ci", test: "db connects", note: "a connection reset" },
      };
    });
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
    // A cancel that races the claim changes nothing: the claimed job stands.
    await expect(
      call("babysit.next", { workItemId: a.id, deliveryFence: 1, cancel: true }, BABYSITTER),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await first<{ babysit_job_id: string }>(
        "SELECT babysit_job_id FROM core_delivery_state WHERE key = ?",
        `${a.projectId}:${a.repositoryId}`,
      ),
    ).toEqual({ babysit_job_id: dead.id });
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

  it("an older runner never gets a babysit job: it waits saying why, then the delivery ends for a person", async () => {
    const w = await world();
    // The only runner online is an older host: it doesn't declare `babysit`.
    await env.DB.prepare("UPDATE core_runners SET last_seen_at = ? WHERE id != ?")
      .bind("2026-01-01T00:00:00.000Z", w.runner.runnerId)
      .run();
    const older = {
      ...MANIFEST,
      capabilities: MANIFEST.capabilities.filter((c) => c !== "babysit"),
    };
    const a = await toMergeGate(w, "No one to babysit", "src/a.ts");
    await ok(
      "runner.heartbeat",
      { manifest: older, capacity: { max: 4, inUse: 0, accepting: true }, activeJobs: [] },
      w.runnerActor,
    );
    await github.push(w.repo, "main", undefined, ["src/a.ts"]);
    await github.setMergeable(w.repo, a.pr, false);
    await approve(w, a.id);
    const job = await babysitJob(a.id);
    const none = await ok<{ job: unknown }>(
      "job.claim",
      { claimId: uid("claim-"), manifest: older, capacity: { max: 4, inUse: 0, accepting: true } },
      w.runnerActor,
    );
    expect(none.job).toBeNull();
    expect(
      await first<{ wait_reason: string }>(
        "SELECT wait_reason FROM core_jobs WHERE id = ?",
        job.id,
      ),
    ).toEqual({ wait_reason: NO_BABYSIT_RUNNER });
    // Past the recheck, the job is cancelled and the delivery ends saying why.
    await env.DB.prepare("UPDATE core_jobs SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 11 * 60_000).toISOString(), job.id)
      .run();
    await deliverRepository(env, a.projectId, a.repositoryId);
    const left = await waitFor("the delivery ended", async () => {
      const e = await entry(a.id);
      return e?.status === "left" ? e : null;
    });
    expect(left?.end_reason).toMatch(/no runner that can babysit is online/);
    expect(
      await first<{ status: string }>("SELECT status FROM core_jobs WHERE id = ?", job.id),
    ).toEqual({ status: "cancelled" });
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("a babysit job no runner claims in 30 minutes ends the wait, saying why", async () => {
    const w = await world();
    const a = await toMergeGate(w, "Nobody claims it", "src/a.ts");
    await github.push(w.repo, "main", undefined, ["src/a.ts"]);
    await github.setMergeable(w.repo, a.pr, false);
    await approve(w, a.id);
    const job = await babysitJob(a.id);
    // No runner asked for work at all, so no wait reason was ever set.
    await env.DB.prepare("UPDATE core_jobs SET created_at = ?, wait_reason = NULL WHERE id = ?")
      .bind(new Date(Date.now() - 31 * 60_000).toISOString(), job.id)
      .run();
    await deliverRepository(env, a.projectId, a.repositoryId);
    const left = await waitFor("the delivery ended", async () => {
      const e = await entry(a.id);
      return e?.status === "left" ? e : null;
    });
    expect(left?.end_reason).toMatch(/no runner claimed the babysit job in 30 minutes/);
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

type Tree = { set?: Record<string, { mode: string; sha: string }>; remove?: string[] };
interface ResolutionView {
  status: string;
  reason: string | null;
  files: {
    path: string;
    conflicted: boolean;
    took: string;
    note: string | null;
    previousPath: string | null;
    patchOmitted: boolean;
    patchTruncated: boolean;
  }[];
  outside: string[];
  notShown: number;
}

/**
 * A conflict at delivery, resolved by the babysit job's run branch as `craft` makes it, then the
 * resolution as the reopened gate reads it.
 */
async function resolvedAs(
  title: string,
  craft: (w: World, a: Item, branch: string) => Promise<string>,
): Promise<{ w: World; a: Item; view: ResolutionView | null }> {
  const w = await world();
  const a = await toMergeGate(w, title, "src/a.ts");
  await github.push(w.repo, "main", undefined, ["src/a.ts"]);
  await github.setMergeable(w.repo, a.pr, false);
  await approve(w, a.id);
  await babysitJob(a.id);
  await runStage(w, a.id, "babysit", async (claimed) => ({
    headSha: await craft(w, a, claimed.branch),
    result: { verdict: "resolved", note: "resolved" },
  }));
  await waitFor("the resolution recorded", () =>
    first("SELECT work_item_id FROM core_babysit_resolutions WHERE work_item_id = ?", a.id),
  );
  const got = await ok<{ babysitResolution: ResolutionView | null }>(
    "workItem.get",
    { workItemId: a.id },
    w.human,
  );
  return { w, a, view: got.babysitResolution };
}

const mergeOf =
  (
    tree: Tree,
    touches?: Parameters<typeof github.craftMerge>[3] extends infer O
      ? O extends { touches?: infer T }
        ? T
        : never
      : never,
  ) =>
  async (w: World, a: Item, branch: string) => {
    await github.createBranch(w.repo, branch, a.head);
    return github.craftMerge(w.repo, branch, "main", { tree, ...(touches ? { touches } : {}) });
  };

describe("the resolution at the reopened gate (decision 1)", () => {
  it("flags a file outside the conflict; a mode change counts as the resolution's", async () => {
    const { w, a, view } = await resolvedAs(
      "Resolves too much",
      mergeOf({
        set: {
          "src/a.ts": { mode: "100755", sha: "a-resolved" },
          "src/unrelated.ts": { mode: "100644", sha: "sneaked-in" },
        },
      }),
    );
    expect(view?.status).toBe("clean");
    expect(view?.outside.sort()).toEqual(["src/unrelated.ts"]);
    expect(view?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/a.ts", conflicted: true }),
        expect.objectContaining({ path: "src/unrelated.ts", conflicted: false }),
      ]),
    );
    // The patches are read on demand, not with the item.
    const patches = await ok<{ headSha: string | null }>(
      "babysit.resolutionPatches",
      { workItemId: a.id },
      w.human,
    );
    expect(patches.headSha).not.toBeNull();
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("a resolution that deletes the conflicted file lists the deletion", async () => {
    const { w, a, view } = await resolvedAs(
      "Resolved by deleting",
      mergeOf({ remove: ["src/a.ts"] }),
    );
    expect(view).toMatchObject({
      status: "clean",
      files: [{ path: "src/a.ts", conflicted: true }],
      outside: [],
    });
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("taking the item's side of a file only main changed undoes main's change: listed as a deviation", async () => {
    const w = await world();
    // Main lands a fix to src/auth.ts, which the item never touched, alongside the conflict.
    const a = await toMergeGate(w, "Drops main's fix", "src/a.ts");
    await github.push(w.repo, "main", undefined, ["src/a.ts", "src/auth.ts"]);
    await github.setMergeable(w.repo, a.pr, false);
    await approve(w, a.id);
    await babysitJob(a.id);
    await runStage(w, a.id, "babysit", async (claimed) => {
      await github.createBranch(w.repo, claimed.branch, a.head);
      // The merge keeps the item's (absent) auth.ts: main's fix is gone.
      const merged = await github.craftMerge(w.repo, claimed.branch, "main", {
        tree: {
          set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } },
          remove: ["src/auth.ts"],
        },
      });
      return { headSha: merged, result: { verdict: "resolved", note: "resolved" } };
    });
    await waitFor("the resolution recorded", () =>
      first("SELECT work_item_id FROM core_babysit_resolutions WHERE work_item_id = ?", a.id),
    );
    const got = await ok<{ babysitResolution: ResolutionView }>(
      "workItem.get",
      { workItemId: a.id },
      w.human,
    );
    expect(got.babysitResolution.outside).toEqual(["src/auth.ts"]);
    expect(got.babysitResolution.files).toContainEqual(
      expect.objectContaining({
        path: "src/auth.ts",
        conflicted: false,
        note: "differs from the default branch's change, which a merge would take",
      }),
    );
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("a conflicted file resolved wholly to one side is listed, saying which side was discarded", async () => {
    const { w, a, view } = await resolvedAs("Takes the item's side", async (w_, a_, branch) => {
      const mine = (await github.pathEntries(w_.repo, a_.head, ["src/a.ts"]))["src/a.ts"];
      await github.createBranch(w_.repo, branch, a_.head);
      return github.craftMerge(w_.repo, branch, "main", {
        tree: { set: { "src/a.ts": mine ?? { mode: "100644", sha: "x" } } },
      });
    });
    expect(view?.files).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        conflicted: true,
        took: "item",
        note: "took the item's side: the default branch's change is discarded",
      }),
    ]);
    expect(view?.outside).toEqual([]);
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("a second parent that isn't on the default branch is unclean", async () => {
    const { w, a, view } = await resolvedAs("Merged the wrong thing", async (w_, a_, branch) => {
      const side = await github.push(w_.repo, "side-branch", undefined, ["src/a.ts"]);
      await github.createBranch(w_.repo, branch, a_.head);
      return github.craftMerge(w_.repo, branch, side, {
        tree: { set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } } },
      });
    });
    expect(view?.status).toBe("unclean");
    expect(view?.reason).toMatch(/isn't on main/);
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("flags an omitted or clipped patch, and keeps a rename's old path", async () => {
    const { w, a, view } = await resolvedAs(
      "Renames and long patches",
      mergeOf(
        {
          set: {
            "src/a.ts": { mode: "100644", sha: "a-resolved" },
            "src/b-new.ts": { mode: "100644", sha: "moved" },
            "src/blob.bin": { mode: "100644", sha: "binary" },
          },
        },
        [
          { path: "src/a.ts", status: "modified", patch: "x".repeat(5000) },
          {
            path: "src/b-new.ts",
            status: "renamed",
            previousPath: "src/b.ts",
            patch: "@@ -1 +1 @@",
          },
        ],
      ),
    );
    const byPath = new Map(view?.files.map((f) => [f.path, f]));
    expect(byPath.get("src/a.ts")).toMatchObject({ patchTruncated: true, patchOmitted: false });
    expect(byPath.get("src/b-new.ts")).toMatchObject({ previousPath: "src/b.ts" });
    expect(byPath.get("src/blob.bin")).toMatchObject({ patchOmitted: true });
    // An ended item's resolution goes with the hourly prune.
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
    await pruneBabysit(env.DB, new Date());
    expect(
      await first("SELECT work_item_id FROM core_babysit_resolutions WHERE work_item_id = ?", a.id),
    ).toBeNull();
  });

  it("a deletion GitHub shows as a rename is still judged: the deleted file is listed", async () => {
    const { w, a } = await directResolution("Renamed away");
    // x.ts was on main before the item branched; main now adds y.ts with the same content.
    const r = await w.craft(async (branch) =>
      github.craftMerge(w.w.repo, branch, "main", {
        tree: {
          set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } },
          remove: ["src/x.ts"],
        },
        touches: [{ path: "src/y.ts", status: "renamed", previousPath: "src/x.ts" }],
      }),
    );
    const view = await w.record(r);
    expect(view?.status).toBe("clean");
    expect(view?.outside).toContain("src/x.ts");
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.w.human);
  });

  it("an item and main with more than one merge base (a criss-cross) are unclean: review the whole diff", async () => {
    const { w, a } = await directResolution("Criss-crossed");
    // Each side merged the other: the item merged main, and main merged the item's commit.
    const first = a.head;
    await w.craft(async (branch) => github.craftMerge(w.w.repo, branch, "main"));
    await github.craftMerge(w.w.repo, "main", first);
    const r = await w.craft(async (branch) =>
      github.craftMerge(w.w.repo, branch, "main", {
        tree: { set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } } },
      }),
    );
    const view = await w.record(r);
    expect(view).toMatchObject({ status: "unclean", files: [] });
    expect(view?.reason).toMatch(/more than one merge base/);
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.w.human);
  });

  it("a merge whose first parent isn't the approved head is unclean: review the whole diff", async () => {
    const { w, a, view } = await resolvedAs("Changed before merging", async (w_, a_, branch) => {
      // The agent commits on top of the approved head, then merges main: its change would pass
      // for a parent's content.
      await github.createBranch(w_.repo, branch, a_.head);
      await github.push(w_.repo, branch, undefined, ["src/hidden.ts"]);
      return github.craftMerge(w_.repo, branch, "main", {
        tree: { set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } } },
      });
    });
    expect(view).toMatchObject({ status: "unclean", files: [], outside: [] });
    expect(view?.reason).toMatch(/not a merge of the approved head.*review the whole diff/);
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("past what it lists, it says how many aren't shown", async () => {
    const set: NonNullable<Tree["set"]> = { "src/a.ts": { mode: "100644", sha: "a-resolved" } };
    for (let i = 0; i < 52; i++) set[`src/extra-${i}.ts`] = { mode: "100644", sha: `x${i}` };
    const { w, a, view } = await resolvedAs("Resolves a lot", mergeOf({ set }));
    expect(view?.status).toBe("clean");
    expect(view?.files).toHaveLength(50);
    expect(view?.notShown).toBe(3);
    expect(view?.outside).toHaveLength(52);
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("a change too large to read in full is incomplete: review the whole diff", async () => {
    const { w, a, view } = await resolvedAs("Too large", async (w_, a_, branch) => {
      await github.truncateTree(w_.repo, a_.head);
      return mergeOf({ set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } } })(
        w_,
        a_,
        branch,
      );
    });
    expect(view).toMatchObject({ status: "incomplete", files: [] });
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });

  it("once the head moves past the resolution, it isn't shown", async () => {
    const { w, a } = await resolvedAs(
      "Then pushed again",
      mergeOf({ set: { "src/a.ts": { mode: "100644", sha: "a-resolved" } } }),
    );
    await env.DB.prepare("UPDATE core_work_items SET head_sha = ? WHERE id = ?")
      .bind("f".repeat(40), a.id)
      .run();
    const got = await ok<{ babysitResolution: unknown }>(
      "workItem.get",
      { workItemId: a.id },
      w.human,
    );
    expect(got.babysitResolution).toBeNull();
    await ok("workItem.cancel", { workItemId: a.id, reason: "end of test" }, w.human);
  });
});

/**
 * An item at its merge gate whose branch the test shapes itself, then `babysit.resolution` called
 * as the deliverer calls it: for histories the delivery flow can't make in the fake.
 */
async function directResolution(title: string) {
  const w = await world();
  await github.push(w.repo, "main", undefined, ["src/x.ts"]);
  const a = await toMergeGate(w, title, "src/a.ts");
  await github.push(w.repo, "main", undefined, ["src/a.ts", "src/y.ts"]);
  const key = `${a.projectId}:${a.repositoryId}`;
  await env.DB.prepare(
    "INSERT INTO core_delivery_state (key, project_id, repository_id, updated_at, babysit_fence) VALUES (?, ?, ?, ?, 1) ON CONFLICT (key) DO UPDATE SET babysit_fence = 1",
  )
    .bind(key, a.projectId, a.repositoryId, new Date().toISOString())
    .run();
  let approved = a.head;
  const craft = async (make: (branch: string) => Promise<string>) => {
    const sha = await make(a.branch);
    return sha;
  };
  const record = async (resolution: string) => {
    approved = (await github.commitParents(w.repo, resolution))[0] ?? approved;
    await ok(
      "babysit.resolution",
      { workItemId: a.id, headSha: resolution, approvedHead: approved, deliveryFence: 1 },
      BABYSITTER,
    );
    await env.DB.prepare("UPDATE core_work_items SET head_sha = ? WHERE id = ?")
      .bind(resolution, a.id)
      .run();
    return (
      await ok<{ babysitResolution: ResolutionView | null }>(
        "workItem.get",
        { workItemId: a.id },
        w.human,
      )
    ).babysitResolution;
  };
  return { w: { w, craft, record }, a };
}
