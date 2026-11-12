// Spec 51 PR B (ADR 0501): the factory runs the project's checks itself. The build job carries
// them, the host's results decide, a failure after the session's own fixes asks a person, and the
// reviewer's word alone never proves a criterion.
import { env } from "cloudflare:workers";
import type { Job } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { pruneCheckResults } from "../src/index.ts";
import {
  all,
  BALANCED,
  build,
  call,
  first,
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

/** Waits until the item's Workflow has queued its verify job and holds still (it bumps updated_at). */
const settled = (id: string) =>
  waitFor("a queued verify job", () =>
    first("SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'verify'", id),
  );

/** `factory/verify` on a SHA, with what it says. */
const verifyRun = async (w: World, sha: string) => {
  const state = await github.state(w.repo);
  const run = (state.checks?.[sha] ?? []).find((c) => c.name === "factory/verify");
  return run ? { ...run, output: state.checkOutputs?.[run.id] } : undefined;
};

const CHECKS = {
  ...BALANCED,
  retryLimit: 2,
  checks: [
    { name: "lint", run: "pnpm lint" },
    { name: "tests", run: "pnpm test", timeoutMinutes: 20 },
  ],
};

async function create(w: Awaited<ReturnType<typeof world>>, title = "Add dark mode") {
  return ok<{ workItemId: string; branch: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
}

const linkedPass = {
  result: {
    ...verifyPass.result,
    criteria: [
      {
        criterion: "The page has a dark mode toggle",
        met: true,
        evidence: "theme.test.ts › toggles",
        checks: ["tests"],
      },
    ],
  },
};

describe("checks the factory runs itself (spec 51, ADR 0501)", () => {
  it("puts the declared checks on the build job and decides from the host's results; the reviewer's links prove nothing", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    const job = await runStage(w, item.workItemId, "build", (j) => {
      expect(j.checks).toEqual({
        commands: [
          { name: "lint", run: "pnpm lint", timeoutMs: 15 * 60_000 },
          { name: "tests", run: "pnpm test", timeoutMs: 20 * 60_000 },
        ],
        fixRounds: 2,
      });
      return {
        ...build(),
        checks: [
          { name: "lint", exitCode: 0 },
          { name: "tests", exitCode: 0 },
        ],
      };
    });
    expect(job.checks?.commands).toHaveLength(2);
    const verify = await runStage(w, item.workItemId, "verify", (j) => {
      expect(j.checks).toBeUndefined(); // a factory item's verify uses the build's results
      expect(j.harness.prompt).toMatch(/`lint`, `tests`/);
      return linkedPass;
    });
    await gateOpen(item.workItemId, "merge");
    const packet = await first<{ verdict: string; sections: string }>(
      "SELECT verdict, sections FROM core_review_packets WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(packet?.verdict).toBe("pass");
    const sections = JSON.parse(packet?.sections ?? "{}");
    // A small item has no approved spec: the reviewer linked "tests", which passed, but only a
    // person's link (the spec's) proves a criterion.
    expect(sections.proof).toMatchObject([
      { proven: false, provenBy: [], notCounted: ["tests"], linkedBy: "reviewer" },
    ]);
    expect(sections.executed.results).toMatchObject([
      { name: "lint", passed: true },
      { name: "tests", passed: true },
    ]);
    expect(verify.stage).toBe("verify");
    // factory/verify on the head says what the factory ran and what it proved.
    const head = String(verify.context.headSha);
    const run = await verifyRun(w, head);
    expect(run).toMatchObject({ conclusion: "success" });
    expect(String(run?.output?.summary)).toContain(
      "### Checks run by the factory\n- lint: passed (`pnpm lint`, exit 0, 1 s)\n- tests: passed (`pnpm test`, exit 0, 1 s)",
    );
    expect(String(run?.output?.summary)).toContain("Criteria proven by an executed check: 0/1");
  });

  it("goes on to verify and the merge gate when the runner could not run the checks: said plainly, never passed or proven, no build burned", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    const reason = "the sandbox could not start: bwrap: setting up uid map: Permission denied";
    await runStage(w, item.workItemId, "build", () => ({
      ...build(),
      checks: [
        { name: "lint", exitCode: null, notRun: reason },
        { name: "tests", exitCode: null, notRun: reason },
        // Not a declared check: refused, never stored.
        { name: "proves-everything", exitCode: 0 },
      ],
    }));
    const rows = await all<{ name: string; not_run: string | null; exit_code: number | null }>(
      "SELECT name, not_run, exit_code FROM core_check_results WHERE work_item_id = ? ORDER BY name",
      item.workItemId,
    );
    expect(rows).toEqual([
      { name: "lint", not_run: reason, exit_code: null },
      { name: "tests", not_run: reason, exit_code: null },
    ]);
    // No question at build, no second build: straight to verify.
    const verify = await runStage(w, item.workItemId, "verify", () => linkedPass);
    await gateOpen(item.workItemId, "merge");
    // Fourth review, S2: with CI green and the reviewer approving, factory/verify is still not
    // success: action required, saying how many declared checks could not run and why.
    const head = String(verify.context.headSha);
    const posted = await verifyRun(w, head);
    expect(posted).toMatchObject({ conclusion: "action_required" });
    expect(String(posted?.output?.title)).toBe(
      `2 declared checks could not be run on this runner: ${reason}`,
    );
    // A person merges only by deciding to merge without them, never by the plain merge.
    const plain = await call(
      "review.merge",
      { workItemId: item.workItemId, openedFullDiff: true },
      w.human,
    ).catch((e: unknown) => e);
    expect(String((plain as { message?: string }).message ?? JSON.stringify(plain))).toMatch(
      /could not be run on this runner.*merge without these checks/,
    );
    await ok(
      "review.merge",
      { workItemId: item.workItemId, openedFullDiff: true, mergeWithoutChecks: true },
      w.human,
    );
    const decided = await first<{ sections: string }>(
      "SELECT sections FROM core_review_packets WHERE work_item_id = ? AND head_sha = ? ORDER BY created_at DESC",
      item.workItemId,
      head,
    );
    expect(JSON.parse(String(decided?.sections)).notRunWaived).toMatchObject({
      by: w.human.id,
      checks: ["lint", "tests"],
    });
    const gate = await first<{ note: string | null }>(
      "SELECT note FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
      item.workItemId,
    );
    expect(gate?.note).toContain("Merged without these checks");
    const after = await verifyRun(w, head);
    expect(after).toMatchObject({ conclusion: "success" });
    expect(String(after?.output?.title)).toMatch(/merged without 2 checks that could not be run/);
    expect(
      await all("SELECT id FROM core_questions WHERE work_item_id = ?", item.workItemId),
    ).toEqual([]);
    expect(
      await all(
        "SELECT id FROM core_runs WHERE work_item_id = ? AND stage = 'build'",
        item.workItemId,
      ),
    ).toHaveLength(1);
    const packet = await first<{ sections: string }>(
      "SELECT sections FROM core_review_packets WHERE work_item_id = ?",
      item.workItemId,
    );
    const sections = JSON.parse(packet?.sections ?? "{}");
    expect(sections.verdict.warnings).toContainEqual(
      expect.stringContaining(
        `these checks could not be run on this runner: ${reason} (lint, tests)`,
      ),
    );
    expect(sections.executed.results).toMatchObject([
      { name: "lint", passed: false, notRun: reason },
      { name: "tests", passed: false, notRun: reason },
    ]);
    expect(sections.proof.every((p: { proven: boolean }) => !p.proven)).toBe(true);
  });

  it("refuses a merge when there is no review packet for the gate's head: fails closed and says why (fifth review)", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    const reason = "this Mac runner has no container runtime";
    await runStage(w, item.workItemId, "build", () => ({
      ...build(),
      checks: [
        { name: "lint", exitCode: null, notRun: reason },
        { name: "tests", exitCode: null, notRun: reason },
      ],
    }));
    const verify = await runStage(w, item.workItemId, "verify", () => linkedPass);
    await gateOpen(item.workItemId, "merge");
    const head = String(verify.context.headSha);
    // The packet for the head is gone (or was never recorded): nothing says the checks ran.
    await env.DB.prepare("DELETE FROM core_review_packets WHERE work_item_id = ?")
      .bind(item.workItemId)
      .run();
    for (const mergeWithoutChecks of [false, true]) {
      const refused = await call(
        "review.merge",
        { workItemId: item.workItemId, openedFullDiff: true, mergeWithoutChecks },
        w.human,
      ).catch((e: unknown) => e);
      expect(String((refused as { message?: string }).message ?? JSON.stringify(refused))).toMatch(
        new RegExp(`no review packet for ${head.slice(0, 7)}.*Re-run verify`),
      );
    }
    const gate = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
      item.workItemId,
    );
    expect(gate?.status).toBe("pending");
  });

  it("refuses check results that didn't run on the run's head", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => ({
      ...build(),
      checks: [
        { name: "lint", exitCode: 0, headSha: "d".repeat(40) },
        { name: "tests", exitCode: 0, headSha: "d".repeat(40) },
      ],
    }));
    const run = await waitFor("the build run failed", () =>
      first<{ status: string }>(
        "SELECT status FROM core_runs WHERE work_item_id = ? AND stage = 'build' AND status = 'failed'",
        item.workItemId,
      ),
    );
    expect(run.status).toBe("failed");
    expect(
      await all("SELECT name FROM core_check_results WHERE work_item_id = ?", item.workItemId),
    ).toEqual([]);
  });

  // v7 (PR #79) waits for the release after the shaping stages (`version >= 7 && waitForRelease()`)
  // and v8 builds on it. A v8 item released without shaping (created queued, so already pulled, ADR
  // 0491) must go straight from triage to build: waitForRelease is a no-op for it. (A shaped v8 item
  // waiting for its release is shaping.test.ts, which runs at the current version.)
  it("runs a v8 item released without shaping straight from triage to build (no release wait)", async () => {
    const w = await world(CHECKS);
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Released, never shaped" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    const job = await runStage(w, item.workItemId, "build", () => build());
    expect(job.checks?.commands).toHaveLength(2);
    const row = await first<{ workflow_version: number }>(
      "SELECT workflow_version FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row?.workflow_version).toBe(8);
  });

  it("places a build that carries checks only on a runner that declares `checks`", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    const queued = await waitFor("a queued build job", () =>
      first<{ requires: string }>(
        "SELECT requires FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
        item.workItemId,
      ),
    );
    expect(JSON.parse(queued.requires)).toContain("checks");
    // An older runner (no `checks`) would drop the field and hand back with none: it isn't offered.
    const older = await ok<{ job: Job | null }>(
      "job.claim",
      {
        claimId: uid("claim-"),
        manifest: { ...MANIFEST, capabilities: ["hooks", "headless"] },
        capacity: { max: 4, inUse: 0, accepting: true },
      },
      w.runnerActor,
    );
    expect(older.job).toBeNull();
    const job = await runStage(w, item.workItemId, "build", () => build());
    expect(job.checks?.commands).toHaveLength(2);
  });

  it("says why a build that carries checks waits when no online runner declares `checks` (fifth review)", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await waitFor("a queued build job", () =>
      first("SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'", item.workItemId),
    );
    // Every other runner is offline, and this one now reports no `checks` (a sprite runner): the
    // build waits, saying why.
    await env.DB.prepare("UPDATE core_runners SET last_seen_at = ? WHERE id != ?")
      .bind("2026-01-01T00:00:00.000Z", w.runner.runnerId)
      .run();
    const without = { ...MANIFEST, capabilities: ["hooks", "headless"] };
    await ok(
      "runner.heartbeat",
      { manifest: without, capacity: { max: 4, inUse: 0, accepting: true }, activeJobs: [] },
      w.runnerActor,
    );
    const refused = await ok<{ job: Job | null }>(
      "job.claim",
      {
        claimId: uid("claim-"),
        manifest: without,
        capacity: { max: 4, inUse: 0, accepting: true },
      },
      w.runnerActor,
    );
    expect(refused.job).toBeNull();
    const waiting = await first<{ wait_reason: string | null }>(
      "SELECT wait_reason FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
      item.workItemId,
    );
    expect(waiting?.wait_reason).toBe("no runner that can run this project's checks is online");
    // A runner that declares `checks` takes it.
    await ok(
      "runner.heartbeat",
      { manifest: MANIFEST, capacity: { max: 4, inUse: 0, accepting: true }, activeJobs: [] },
      w.runnerActor,
    );
    const job = await runStage(w, item.workItemId, "build", () => build());
    expect(job.checks?.commands).toHaveLength(2);
  });

  it("drops results on a commit that isn't on the head's history (an amended fix round), and keeps the run", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    const amended = "e".repeat(40);
    await runStage(w, item.workItemId, "build", () => ({
      ...build(),
      checks: [
        // Round 0 ran on a commit the fix round then amended: never pushed, not an ancestor.
        { name: "lint", exitCode: 0, headSha: amended, round: 0 },
        { name: "tests", exitCode: 1, headSha: amended, round: 0 },
        { name: "lint", exitCode: 0, round: 1 },
        { name: "tests", exitCode: 0, round: 1 },
      ],
    }));
    const run = await waitFor("the build run handed back", () =>
      first<{ status: string; head_sha: string }>(
        "SELECT status, head_sha FROM core_runs WHERE work_item_id = ? AND stage = 'build' AND status = 'handed_back'",
        item.workItemId,
      ),
    );
    const rows = await all<{ name: string; head_sha: string }>(
      "SELECT name, head_sha FROM core_check_results WHERE work_item_id = ? ORDER BY name",
      item.workItemId,
    );
    expect(rows.map((r) => r.name)).toEqual(["lint", "tests"]);
    expect(rows.every((r) => r.head_sha === run.head_sha)).toBe(true);
  });

  it("keeps a failed build's own reason, whatever its check results say", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(
      w,
      item.workItemId,
      "build",
      () => ({
        outcome: "failed",
        checks: [{ name: "tests", exitCode: 1, headSha: "f".repeat(40) }],
      }),
      { summary: "the session crashed" },
    );
    const run = await waitFor("the build run failed", () =>
      first<{ status: string; error: string | null; summary: string | null }>(
        "SELECT * FROM core_runs WHERE work_item_id = ? AND stage = 'build' AND status = 'failed'",
        item.workItemId,
      ),
    );
    expect(JSON.stringify(run)).not.toMatch(/check results|isn't an ancestor|not the run's head/);
    expect(
      await all("SELECT name FROM core_check_results WHERE work_item_id = ?", item.workItemId),
    ).toEqual([]);
  });

  it("runs an attached PR's checks in its verify job, on the PR's head, and proves from them", async () => {
    const w = await world(CHECKS);
    const branch = `tim/${uid("b")}`;
    const pr = await github.openOutsidePull(w.repo, { branch, title: "Dark mode", body: "x" });
    const item = await ok<{ workItemId: string }>(
      "workItem.attachPr",
      { projectId: w.projectId, prNumber: pr.number },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "verify", (j) => {
      // The host runs them before the reviewer, on the PR's head; no fix rounds (no build).
      expect(j.checks).toEqual({
        commands: [
          { name: "lint", run: "pnpm lint", timeoutMs: 15 * 60_000 },
          { name: "tests", run: "pnpm test", timeoutMs: 20 * 60_000 },
        ],
        fixRounds: 0,
      });
      // The reviewer is told the names, to link criteria to.
      expect(j.harness.prompt).toMatch(/`lint`, `tests`/);
      return {
        ...linkedPass,
        checks: [
          { name: "lint", exitCode: 0, headSha: pr.headSha },
          { name: "tests", exitCode: 0, headSha: pr.headSha },
        ],
      };
    });
    await gateOpen(item.workItemId, "merge");
    const packet = await first<{ verdict: string; sections: string }>(
      "SELECT verdict, sections FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
      item.workItemId,
      pr.headSha,
    );
    expect(packet?.verdict).toBe("pass");
    expect(JSON.parse(String(packet?.sections)).proof).toMatchObject([
      { proven: false, notCounted: ["tests"], linkedBy: "reviewer" },
    ]);
  });

  it("labels check results the merge queue carries to a new head as run on the old one", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => ({
      ...build(),
      checks: [
        { name: "lint", exitCode: 0 },
        { name: "tests", exitCode: 0 },
      ],
    }));
    await runStage(w, item.workItemId, "verify", () => linkedPass);
    await gateOpen(item.workItemId, "merge");
    // main moves on, so the queue merges it into the approved head: a new SHA nothing ran on.
    await github.push(w.repo, "main", undefined, ["README.md"]);
    await github.setCiDefault(w.repo, [
      { name: "ci", status: "in_progress", conclusion: null, appSlug: "github-actions", url: null },
    ]);
    await ok("review.merge", { workItemId: item.workItemId, openedFullDiff: true }, w.human);
    const queued = await waitFor("brought up to date", () =>
      first<{ head_sha: string; approved_sha: string }>(
        "SELECT head_sha, approved_sha FROM core_merge_queue WHERE work_item_id = ? AND status = 'queued' AND head_sha != approved_sha",
        item.workItemId,
      ),
    );
    const carried = await first<{ sections: string }>(
      "SELECT sections FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
      item.workItemId,
      queued.head_sha,
    );
    expect(JSON.parse(String(carried?.sections)).checksRanOn).toBe(queued.approved_sha);
    const run = await waitFor("factory/verify on the new head", () =>
      verifyRun(w, queued.head_sha),
    );
    expect(String(run.output?.summary)).toMatch(
      new RegExp(`tests: passed .* ran on ${queued.approved_sha.slice(0, 7)}, not on this commit`),
    );
  });

  it("asks a person when a check still fails after the build session's fixes, never a cold retry", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => ({
      ...build(),
      checks: [
        { name: "lint", exitCode: 0 },
        { name: "tests", exitCode: 1 },
      ],
    }));
    const q = await waitFor("a question about the failing checks", () =>
      first<{ id: string; prompt: string; context: string }>(
        "SELECT id, prompt, context FROM core_questions WHERE work_item_id = ? AND status = 'open'",
        item.workItemId,
      ),
    );
    expect(q.prompt).toMatch(/checks still fail/);
    expect(q.context).toMatch(/check tests failed .*`pnpm test` exited 1/);
    await itemStatus(item.workItemId, "waiting");
    await ok(
      "question.answer",
      { questionId: q.id, answer: "Build again with the failure" },
      w.human,
    );
    await runStage(w, item.workItemId, "build", (j) => {
      expect(j.harness.prompt).toMatch(/The factory's checks failed/);
      return {
        ...build(["src/theme.ts", "src/fix.ts"]),
        checks: [
          { name: "lint", exitCode: 0 },
          { name: "tests", exitCode: 0 },
        ],
      };
    });
    await runStage(w, item.workItemId, "verify", () => linkedPass);
    await gateOpen(item.workItemId, "merge");
  });

  it("fails the verdict when a declared check didn't run, even if the reviewer says every check passed", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    // An old runner that ignores job.checks: no results on the head.
    await runStage(w, item.workItemId, "build", () => build());
    const q = await waitFor("a question about the missing checks", () =>
      first<{ id: string; context: string }>(
        "SELECT id, context FROM core_questions WHERE work_item_id = ? AND status = 'open'",
        item.workItemId,
      ),
    );
    expect(q.context).toMatch(/check lint didn't run/);
    await ok("question.answer", { questionId: q.id, answer: "Stop this work item" }, w.human);
    await itemStatus(item.workItemId, "failed");
  });
  it("keeps check results while their item is open and 30 days after it ends, then prunes them (bounded)", async () => {
    const w = await world(CHECKS);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => ({
      ...build(),
      checks: [
        { name: "lint", exitCode: 0 },
        { name: "tests", exitCode: 0 },
      ],
    }));
    await settled(item.workItemId);
    const old = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare("UPDATE core_check_results SET created_at = ? WHERE work_item_id = ?")
      .bind(old, item.workItemId)
      .run();
    const count = async () =>
      (await all("SELECT name FROM core_check_results WHERE work_item_id = ?", item.workItemId))
        .length;
    const now = new Date("2026-11-12T00:00:00.000Z");
    // Open: kept, however old (the merge gate's evidence).
    await pruneCheckResults(env.DB, now);
    expect(await count()).toBe(2);
    // Ended 10 days ago: kept.
    await env.DB.prepare("UPDATE core_work_items SET status = 'done', updated_at = ? WHERE id = ?")
      .bind("2026-11-02T00:00:00.000Z", item.workItemId)
      .run();
    await pruneCheckResults(env.DB, now);
    expect(await count()).toBe(2);
    // Ended more than 30 days ago: gone, at most `limit` rows a time.
    await env.DB.prepare("UPDATE core_work_items SET updated_at = ? WHERE id = ?")
      .bind(old, item.workItemId)
      .run();
    expect(await pruneCheckResults(env.DB, now, 1)).toBe(1);
    expect(await pruneCheckResults(env.DB, now)).toBe(1);
    expect(await count()).toBe(0);
  });

  it("reads at most `limit` rows a time and passes over an open item's old rows (fifth review)", async () => {
    // A world each: a runner claims the first item's verify job before the second's triage.
    const built = async (title: string) => {
      const w = await world(CHECKS);
      const item = await create(w, title);
      await runStage(w, item.workItemId, "triage", () => triage("small"));
      await runStage(w, item.workItemId, "build", () => ({
        ...build(),
        checks: [
          { name: "lint", exitCode: 0 },
          { name: "tests", exitCode: 0 },
        ],
      }));
      await settled(item.workItemId);
      return item.workItemId;
    };
    const open = await built("Still open");
    const ended = await built("Long done");
    await env.DB.prepare("DELETE FROM core_meta WHERE key = 'check_results_prune_after'").run();
    // The open item's rows are the oldest: a prune that started from them every hour would stall.
    for (const [id, at] of [
      [open, "2025-12-01T00:00:00.000Z"],
      [ended, "2026-01-01T00:00:00.000Z"],
    ] as const) {
      await env.DB.prepare("UPDATE core_check_results SET created_at = ? WHERE work_item_id = ?")
        .bind(at, id)
        .run();
    }
    await env.DB.prepare("UPDATE core_work_items SET status = 'done', updated_at = ? WHERE id = ?")
      .bind("2026-01-02T00:00:00.000Z", ended)
      .run();
    const now = new Date("2026-11-12T00:00:00.000Z");
    const left = async (id: string) =>
      (await all("SELECT name FROM core_check_results WHERE work_item_id = ?", id)).length;
    // Other tests' rows are newer than the cutoff, so these four are the only old ones.
    expect(await pruneCheckResults(env.DB, now, 2)).toBe(0); // the open item's two: kept
    expect(await pruneCheckResults(env.DB, now, 2)).toBe(2); // then the ended item's
    expect([await left(open), await left(ended)]).toEqual([2, 0]);
    // At the end it starts over: the open item's rows are read again, and kept.
    expect(await pruneCheckResults(env.DB, now, 2)).toBe(0);
    expect(await left(open)).toBe(2);
  });
});
