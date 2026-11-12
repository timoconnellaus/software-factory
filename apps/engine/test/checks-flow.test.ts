// Spec 51 PR B (ADR 0451): the factory runs the project's checks itself. The build job carries
// them, the host's results decide, a failure after the session's own fixes asks a person, and the
// reviewer's word alone never proves a criterion.
import { describe, expect, it } from "vitest";
import {
  BALANCED,
  build,
  first,
  gateOpen,
  itemStatus,
  ok,
  runStage,
  triage,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

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

describe("checks the factory runs itself (spec 51, ADR 0451)", () => {
  it("puts the declared checks on the build job and decides from the host's results, marking linked criteria proven", async () => {
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
    expect(sections.proof).toMatchObject([{ proven: true, provenBy: ["tests"] }]);
    expect(sections.executed.results).toMatchObject([
      { name: "lint", passed: true },
      { name: "tests", passed: true },
    ]);
    expect(verify.stage).toBe("verify");
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
