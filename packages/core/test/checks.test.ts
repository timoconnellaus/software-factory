// Spec 51 PR B (ADR 0501): checks the factory runs itself, and criteria proven only by them.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import ownPolicy from "../../../.factory/policy.json";
import {
  assemblePacket,
  checkLines,
  declaredChecks,
  executedChecks,
  FOREMAN,
  isStaticCheck,
  notRunLines,
  notRunTitle,
  parseFloor,
  parseProjectPolicy,
  policyImpact,
  proveCriteria,
  specCheckLinks,
  storedProof,
  summarizeCi,
  verifyCheckOutput,
} from "../src/index.ts";
import { newItem, ok, POLICY, world } from "./helpers.ts";

const SHA = "c".repeat(40);
const ran = (name: string, exitCode: number | null, timedOut = false) => ({
  name,
  command: `pnpm ${name}`,
  exitCode,
  timedOut,
  durationMs: 1000,
  logTail: "",
  round: 0,
});
const parsed = (doc: unknown) => {
  const p = parseProjectPolicy(JSON.stringify(doc));
  if (!p.ok) throw new Error(p.error);
  return p.policy;
};
const WITH_CHECKS = {
  ...POLICY,
  checks: [
    { name: "lint", run: "pnpm lint" },
    { name: "tests", run: "pnpm test" },
  ],
};

describe("executed checks and proof (pure)", () => {
  it("needs every declared check to pass on the SHA", () => {
    expect(
      executedChecks(SHA, ["lint", "tests"], [ran("lint", 0), ran("tests", 0)]).reasons,
    ).toEqual([]);
    expect(
      executedChecks(SHA, ["lint", "tests"], [ran("lint", 0), ran("tests", 1)]).reasons,
    ).toEqual(["check tests failed on ccccccc: `pnpm tests` exited 1"]);
    expect(executedChecks(SHA, ["lint", "tests"], [ran("lint", 0)]).reasons).toEqual([
      "check tests didn't run on ccccccc",
    ]);
    expect(executedChecks(SHA, ["tests"], [ran("tests", null, true)]).reasons[0]).toMatch(
      /timed out/,
    );
  });

  const ciWith = (...names: string[]) =>
    summarizeCi(
      names.map((name, i) => ({
        id: String(i),
        name,
        status: "completed" as const,
        conclusion: name === "docs" ? "skipped" : "success",
        appSlug: "gh",
        url: null,
      })),
      "factory",
    );

  it("never marks a criterion proven on the reviewer's links or word, whatever passed", () => {
    const executed = executedChecks(
      SHA,
      ["tests", "lint", "e2e"],
      [ran("tests", 0), ran("lint", 0), ran("e2e", 1)],
    );
    const proof = proveCriteria(
      [
        { criterion: "A", met: true, evidence: "unit", checks: ["tests"] },
        // The reviewer can't prove anything with a CI job or a static check.
        { criterion: "B", met: true, evidence: "ci", checks: ["ci", "lint"] },
        { criterion: "C", met: true, evidence: "I read the code" },
        { criterion: "D", met: true, evidence: "e2e", checks: ["e2e", "docs"] },
      ],
      executed,
      ciWith("ci", "docs"),
    );
    expect(
      proof.map((p) => [p.criterion, p.proven, p.provenBy, p.unproven, p.notCounted, p.linkedBy]),
    ).toEqual([
      ["A", false, [], [], ["tests"], "reviewer"],
      ["B", false, [], [], ["ci", "lint"], "reviewer"],
      ["C", false, [], [], [], "reviewer"],
      ["D", false, [], ["e2e", "docs"], [], "reviewer"],
    ]);
    expect(proof[2]?.opinion).toBe("I read the code");
  });

  it("takes the links from the approved spec where it tags a criterion, and only then counts CI", () => {
    expect(specCheckLinks("Dark mode persists [checks: tests, e2e]")).toEqual({
      text: "Dark mode persists",
      checks: ["tests", "e2e"],
    });
    expect(specCheckLinks("No tag")).toBeNull();
    const executed = executedChecks(SHA, ["tests"], [ran("tests", 0)]);
    const proof = proveCriteria(
      [
        // The reviewer links "tests", but the spec says only "e2e" (CI) proves it.
        { criterion: "Dark mode persists", met: true, evidence: "x", checks: ["tests"] },
        { criterion: "Untagged", met: true, evidence: "x", checks: ["tests"] },
      ],
      executed,
      ciWith("e2e"),
      { specCriteria: ["Dark mode persists [checks: e2e]", "Untagged"], requiredCi: ["e2e"] },
    );
    expect(proof.map((p) => [p.proven, p.provenBy, p.notCounted, p.linkedBy])).toEqual([
      [true, ["e2e"], [], "spec"],
      [false, [], ["tests"], "reviewer"],
    ]);
  });

  it("lets a CI check prove only when the project's config requires it, never a job the PR added", () => {
    const executed = executedChecks(SHA, [], []);
    const proof = proveCriteria(
      [{ criterion: "Dark mode persists", met: true, evidence: "x" }],
      executed,
      ciWith("e2e"),
      { specCriteria: ["Dark mode persists [checks: e2e]"], requiredCi: ["ci", "factory/verify"] },
    );
    expect(proof).toMatchObject([{ proven: false, provenBy: [], notCounted: ["e2e"] }]);
    // factory/verify is the factory's own verdict: never proof of a criterion.
    const own = proveCriteria([], executed, ciWith("factory/verify"), {
      specCriteria: ["A [checks: factory/verify]"],
      requiredCi: ["factory/verify"],
    });
    expect(own).toMatchObject([{ proven: false }]);
  });

  it("counts the spec's criteria: a reworded one inherits nothing, one left out is Not proven, a repeat counts once", () => {
    const executed = executedChecks(SHA, ["tests", "e2e"], [ran("tests", 0), ran("e2e", 0)]);
    const proof = proveCriteria(
      [
        // Reworded by the reviewer: not the spec's criterion, so it isn't counted at all.
        { criterion: "Dark mode is remembered", met: true, evidence: "x", checks: ["e2e"] },
        // The spec's own text (case and a trailing stop aside), in another position, twice.
        { criterion: "the toggle switches the theme.", met: true, evidence: "first" },
        { criterion: "The toggle switches the theme", met: false, evidence: "second" },
        // A tag the reviewer wrote on a criterion is not the spec's link.
        { criterion: "Something else [checks: tests]", met: true, evidence: "x" },
      ],
      executed,
      ciWith(),
      {
        specCriteria: [
          "Dark mode persists [checks: e2e]",
          "The toggle switches the theme [checks: tests, lint]",
          "Something else",
          "Left out by the reviewer [checks: e2e]",
        ],
      },
    );
    expect(
      proof.map((p) => [p.criterion, p.proven, p.provenBy, p.linkedBy, p.reviewerMet]),
    ).toEqual([
      ["Dark mode persists", true, ["e2e"], "spec", false],
      ["The toggle switches the theme", true, ["tests"], "spec", true],
      ["Something else", false, [], "reviewer", true],
      ["Left out by the reviewer", true, ["e2e"], "spec", false],
    ]);
    expect(proof[0]?.opinion).toMatch(/did not address/);
    // The proven count is over the spec's four criteria, whatever the reviewer listed.
    expect(proof).toHaveLength(4);
  });

  it("never passes or proves a check the runner could not run, nor one that ran another command", () => {
    const executed = executedChecks(
      SHA,
      [
        { name: "tests", run: "pnpm tests" },
        { name: "e2e", run: "pnpm e2e" },
      ],
      [
        { ...ran("tests", null), notRun: "the sandbox could not start: bwrap: no user namespaces" },
        { ...ran("e2e", 0), command: "true" },
      ],
    );
    // Not run is not a failure: no verdict reason, its own list.
    expect(executed.notRun).toEqual([
      { name: "tests", reason: "the sandbox could not start: bwrap: no user namespaces" },
    ]);
    expect(executed.reasons).toEqual([
      expect.stringMatching(/check e2e didn't run on ccccccc as declared: it ran `true`/),
    ]);
    expect(notRunLines(executed.notRun)).toEqual([
      expect.stringMatching(
        /^these checks could not be run on this runner: the sandbox could not start: bwrap: no user namespaces \(tests\)/,
      ),
    ]);
    const proof = proveCriteria([], executed, ciWith(), {
      specCriteria: ["A [checks: tests]", "B [checks: e2e]"],
    });
    expect(proof.map((p) => [p.proven, p.unproven])).toEqual([
      [false, ["tests"]],
      [false, ["e2e"]],
    ]);
  });

  it("says a check stopped by a runner limit failed on that limit, and a person decides", () => {
    const reason = "failed: the check ran out of memory (limit 4 GB)";
    const executed = executedChecks(
      SHA,
      [{ name: "tests", run: "pnpm tests" }],
      [{ ...ran("tests", 137), notRun: reason }],
    );
    // Never a pass, never a verdict reason a fix round chases: a person decides.
    expect(executed.notRun).toEqual([{ name: "tests", reason }]);
    expect(executed.reasons).toEqual([]);
    expect(notRunLines(executed.notRun)).toEqual([
      expect.stringMatching(
        /^these checks were stopped by a runner limit, not by the code under check: the check ran out of memory \(limit 4 GB\) \(tests\)\. No fix round was spent on it: a person decides/,
      ),
    ]);
    expect(notRunTitle(executed.notRun)).toBe(
      "1 declared check hit a runner limit: the check ran out of memory (limit 4 GB)",
    );
    expect(checkLines(executed)).toEqual([
      "tests: failed: the check ran out of memory (limit 4 GB)",
    ]);
  });

  it("posts factory/verify as action required, not success, while declared checks were not run (fourth review)", () => {
    const reason = "this Mac runner has no container runtime";
    const packet = assemblePacket({
      headSha: SHA,
      evidence: {
        summary: "",
        criteria: [{ criterion: "A", met: true, evidence: "x" }],
        checks: [],
        reviewer: { role: "review", verdict: "approve", notes: "" },
        riskFlags: [],
      },
      ci: green,
      files: [],
      sameModelAsImplementer: false,
      hostChecks: true,
      declaredChecks: ["lint", "tests"],
      checksRun: [
        { ...ran("lint", 0), isolation: "weaker-sandbox" },
        { ...ran("tests", null), notRun: reason },
      ],
    });
    // Nothing a build can fix: the verdict passes (no build attempt burned)...
    expect(packet.verdict).toBe("pass");
    expect(packet.executed.weaker).toEqual(["lint"]);
    expect(packet.warnings.join("\n")).toMatch(/ran in the weaker sandbox .* \(lint\)/);
    const args = {
      evidencePass: packet.evidencePass,
      evidenceReasons: packet.evidenceReasons,
      warnings: packet.warnings,
      riskFlags: [],
      ci: green,
      workItem: { number: 7, title: "x" },
    };
    // ...but factory/verify is not success.
    const out = verifyCheckOutput({ ...args, ...storedProof(packet.sections) });
    expect(out).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      title: `1 declared check could not be run on this runner: ${reason}`,
    });
    expect(out.summary).toContain(`- tests: ${reason}`);
    expect(out.summary).toContain("in the weaker sandbox");
    // CI still decides first: pending stays pending, failing fails.
    expect(
      verifyCheckOutput({
        ...args,
        ci: { ...green, state: "pending" },
        ...storedProof(packet.sections),
      }).status,
    ).toBe("in_progress");
    // A person's recorded decision to merge without them: success, saying so.
    const waived = verifyCheckOutput({
      ...args,
      ...storedProof({
        ...packet.sections,
        notRunWaived: { by: "usr_1", at: "2026-11-12T00:00:00.000Z", checks: ["tests"] },
      }),
    });
    expect(waived.conclusion).toBe("success");
    expect(waived.title).toMatch(/merged without 1 check that could not be run/);
  });

  it("marks proof weakened when the tests-intact guard found gate-file edits", () => {
    const executed = executedChecks(SHA, ["tests"], [ran("tests", 0)]);
    const [p] = proveCriteria([{ criterion: "A", met: true, evidence: "x" }], executed, ciWith(), {
      gateFilesChanged: true,
      specCriteria: ["A [checks: tests]"],
    });
    expect(p).toMatchObject({ proven: true, weakened: true });
  });

  it("knows a static check by its name or command", () => {
    expect(isStaticCheck("lint")).toBe(true);
    expect(isStaticCheck("quality", "pnpm typecheck")).toBe(true);
    expect(isStaticCheck("tests", "pnpm test")).toBe(false);
    expect(isStaticCheck("e2e", "playwright test")).toBe(false);
  });

  it("ignores the agent's own report of checks in the verdict", () => {
    const packet = assemblePacket({
      headSha: SHA,
      evidence: {
        summary: "",
        criteria: [{ criterion: "A", met: true, evidence: "x", checks: ["tests"] }],
        checks: [{ name: "tests", status: "pass" }],
        reviewer: { role: "review", verdict: "approve", notes: "" },
        riskFlags: [],
      },
      ci: { state: "success", checks: [], failing: [], pending: [] },
      files: [],
      sameModelAsImplementer: false,
      hostChecks: true,
      declaredChecks: ["tests"],
      checksRun: [ran("tests", 1)],
    });
    expect(packet.verdict).toBe("fail");
    expect(packet.reasons).toEqual(["check tests failed on ccccccc: `pnpm tests` exited 1"]);
    expect(packet.proof[0]?.proven).toBe(false);
  });

  const reviewerFailing = {
    summary: "",
    criteria: [{ criterion: "A", met: true, evidence: "x" }],
    checks: [{ name: "tests", status: "fail" as const }],
    reviewer: { role: "review" as const, verdict: "approve" as const, notes: "" },
    riskFlags: [],
  };
  const green = { state: "success" as const, checks: [], failing: [], pending: [] };

  it("keeps the reviewer's failing check as a reason when the project declares no checks", () => {
    const packet = assemblePacket({
      headSha: SHA,
      evidence: reviewerFailing,
      ci: green,
      files: [],
      sameModelAsImplementer: false,
      hostChecks: true,
      declaredChecks: [],
    });
    expect(packet.verdict).toBe("fail");
    expect(packet.reasons).toContain("runner check failing: tests");
  });

  it("leaves an instance from before v8 as it was: the reviewer's checks decide, no proof", () => {
    const packet = assemblePacket({
      headSha: SHA,
      evidence: reviewerFailing,
      ci: green,
      files: [],
      sameModelAsImplementer: false,
      hostChecks: false,
      declaredChecks: ["tests"],
      checksRun: [ran("tests", 0)],
    });
    expect(packet.reasons).toEqual(["runner check failing: tests"]);
    expect(packet.proof).toEqual([]);
    expect(packet.sections.executed).toBeUndefined();
    expect(packet.warnings.join(" ")).not.toMatch(/declares no checks/);
  });

  it("writes factory/verify's checks and proof, and labels results carried to another head", () => {
    const packet = assemblePacket({
      headSha: SHA,
      evidence: {
        ...reviewerFailing,
        checks: [],
        criteria: [{ criterion: "A", met: true, evidence: "x" }],
      },
      ci: green,
      files: [],
      sameModelAsImplementer: false,
      hostChecks: true,
      declaredChecks: ["tests"],
      checksRun: [ran("tests", 0)],
      specCriteria: ["A [checks: tests]"],
    });
    const out = verifyCheckOutput({
      evidencePass: packet.evidencePass,
      evidenceReasons: packet.evidenceReasons,
      warnings: packet.warnings,
      riskFlags: [],
      ci: green,
      workItem: { number: 7, title: "x" },
      ...storedProof(packet.sections),
    });
    expect(out.conclusion).toBe("success");
    expect(out.summary).toContain(
      "### Checks run by the factory\n- tests: passed (`pnpm tests`, exit 0, 1 s)",
    );
    expect(out.summary).toContain("Criteria proven by an executed check: 1/1");
    const carried = storedProof({ ...packet.sections, checksRanOn: SHA });
    expect(carried.checkLines[0]).toMatch(
      /ran on ccccccc, not on this commit \(carried by the merge queue\)/,
    );
  });

  it("reads the checks from config: the project's, then the item's workflow's", () => {
    const p = parsed({
      ...WITH_CHECKS,
      workflows: [{ name: "UI", checks: [{ name: "e2e", run: "pnpm e2e", timeoutMinutes: 30 }] }],
    });
    expect(declaredChecks(p, "ui").map((c) => [c.name, c.timeoutMs])).toEqual([
      ["lint", 15 * 60_000],
      ["tests", 15 * 60_000],
      ["e2e", 30 * 60_000],
    ]);
    expect(declaredChecks(p, null)).toHaveLength(2);
    const dup = parseProjectPolicy(
      JSON.stringify({
        ...WITH_CHECKS,
        workflows: [{ name: "x", checks: [{ name: "LINT", run: "x" }] }],
      }),
    );
    expect(dup.ok).toBe(false);
  });

  it("classifies dropping or changing a check as loosening, adding one as tightening", () => {
    const floor = parseFloor("");
    const before = parsed(WITH_CHECKS);
    const dropped = parsed({ ...WITH_CHECKS, checks: [WITH_CHECKS.checks[0]] });
    const changed = parsed({
      ...WITH_CHECKS,
      checks: [WITH_CHECKS.checks[0], { name: "tests", run: "true" }],
    });
    const added = parsed({
      ...WITH_CHECKS,
      checks: [...WITH_CHECKS.checks, { name: "typecheck", run: "pnpm typecheck" }],
    });
    expect(policyImpact(before, dropped, floor).class).toBe("loosens");
    expect(policyImpact(before, changed, floor).changes[0]?.summary).toMatch(/pnpm test.*true/);
    expect(policyImpact(before, changed, floor).class).toBe("loosens");
    expect(policyImpact(before, added, floor).class).toBe("tightens");
  });
});

describe("checks.forHead (ADR 0501)", () => {
  // Storing results from the hand-back, and the packet built from them, run end to end in
  // apps/engine/test/checks-flow.test.ts.
  it("names the declared checks and says why a head without results doesn't pass", async () => {
    const w = await world(WITH_CHECKS);
    const item = await newItem(w);
    await env.DB.prepare("UPDATE core_work_items SET workflow_version = 8 WHERE id = ?")
      .bind(item.workItemId)
      .run();
    const out = await ok<{ declared: string[]; passed: boolean; failing: string[] }>(
      "checks.forHead",
      { workItemId: item.workItemId, headSha: SHA },
      FOREMAN,
    );
    expect(out).toMatchObject({
      declared: ["lint", "tests"],
      passed: false,
      failing: ["check lint didn't run on ccccccc", "check tests didn't run on ccccccc"],
    });
  });
});

describe("checks.forHead before v8 (ADR 0501)", () => {
  it("declares nothing for an instance that started before v8, so it never fails there", async () => {
    const w = await world(WITH_CHECKS);
    const item = await newItem(w);
    await env.DB.prepare("UPDATE core_work_items SET workflow_version = 6 WHERE id = ?")
      .bind(item.workItemId)
      .run();
    const out = await ok<{ declared: string[]; passed: boolean }>(
      "checks.forHead",
      { workItemId: item.workItemId, headSha: SHA },
      FOREMAN,
    );
    expect(out).toMatchObject({ declared: [], passed: true });
  });
});

describe("this repository's own checks", () => {
  it("declares its test check within the check container's 4 GB: two test workers at a time", () => {
    const policy = parsed(ownPolicy);
    expect(declaredChecks(policy, null).map((c) => c.name)).toEqual(["install", "lint", "test"]);
    expect(policy.checks.find((c) => c.name === "test")?.run).toMatch(/--concurrency=2\b/);
  });
});
