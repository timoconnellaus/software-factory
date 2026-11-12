// Spec 51 PR B (ADR 0501): the factory runs the project's checks itself. The build job carries
// them, the host's results decide, a failure after the session's own fixes asks a person, and the
// reviewer's word alone never proves a criterion.
import type { Job } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import {
  all,
  BALANCED,
  build,
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
    { projectId: w.projectId, title },
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
      "### Checks run by the factory\n- lint: passed (`pnpm lint`, exit 0, 1 s)\n- tests: passed (`pnpm tests`, exit 0, 1 s)",
    );
    expect(String(run?.output?.summary)).toContain("Criteria proven by an executed check: 0/1");
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

  // PR #79 adds v7's release wait (`version >= 7 && waitForRelease()`) and keeps v7; this PR is v8.
  // Whichever lands first, a v8 item that was released without shaping (created queued, so already
  // pulled) must go straight from triage to build: waitForRelease is a no-op for it. `state` is
  // ignored until #79 lands, so this holds on both sides of that merge.
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
    expect(q.context).toMatch(/check tests failed .*`pnpm tests` exited 1/);
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
});
