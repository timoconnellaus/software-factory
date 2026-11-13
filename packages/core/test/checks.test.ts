// Spec 51 PR B (ADR 0501): checks the factory runs itself, and criteria proven only by them.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assemblePacket,
  type CiSummary,
  checkProves,
  declaredChecks,
  everyCriterionProven,
  executedChecks,
  FOREMAN,
  isStaticCheck,
  notRunLines,
  parseFloor,
  parseProjectPolicy,
  policyImpact,
  proofCounts,
  provableChecks,
  proveCriteria,
  specCheckLinks,
  storedProof,
  summarizeCi,
  tieCriteria,
  verifyCheckOutput,
  whyNotProven,
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

  it("says no checks are set up, never 0/N proven, when nothing declared and no required CI reported", () => {
    const base = {
      headSha: SHA,
      evidence: {
        ...reviewerFailing,
        checks: [],
        criteria: [{ criterion: "A", met: true, evidence: "x" }],
      },
      files: [],
      sameModelAsImplementer: false,
      hostChecks: true,
      declaredChecks: [],
    };
    const out = (packet: ReturnType<typeof assemblePacket>, ci: CiSummary = green) =>
      verifyCheckOutput({
        evidencePass: packet.evidencePass,
        evidenceReasons: packet.evidenceReasons,
        warnings: packet.warnings,
        riskFlags: [],
        ci,
        workItem: { number: 7, title: "x" },
        ...storedProof(packet.sections),
      }).summary;
    // The config requires "ci", but no check run of that name reported: nothing could prove.
    const otherCi = ciWith("build");
    const none = assemblePacket({ ...base, ci: otherCi, requiredCi: ["ci"] });
    expect(none.sections.proven).toMatchObject({ proven: 0, total: 1, checksSetUp: false });
    expect(out(none, otherCi)).toContain(
      "No checks are set up for this project, so nothing can be proven.",
    );
    expect(out(none, otherCi)).not.toContain("Criteria proven");
    // factory/verify itself is never what makes checks "set up".
    const onlyVerify = assemblePacket({ ...base, ci: otherCi, requiredCi: ["factory/verify"] });
    expect(onlyVerify.sections.proven).toMatchObject({ checksSetUp: false });
    // A required CI check that reported counts: then the count, and why each criterion isn't proven.
    const ci = ciWith("ci");
    const withCi = assemblePacket({ ...base, ci, requiredCi: ["ci"] });
    expect(withCi.sections.proven).toMatchObject({ checksSetUp: true });
    expect(out(withCi, ci)).toContain("Criteria proven by an executed check: 0/1");
    expect(out(withCi, ci)).toContain("- Not proven: A (no check is named for this)");
    // Declared checks count too.
    const declared = assemblePacket({
      ...base,
      ci: otherCi,
      declaredChecks: ["tests"],
      checksRun: [ran("tests", 0)],
    });
    expect(declared.sections.proven).toMatchObject({ checksSetUp: true });
  });

  it("keeps only declared or required check names in triage's ties; none is an honest answer", () => {
    const tied = tieCriteria(
      ["A.", "B", "C", "D", "E [checks: tests]", "F"],
      [
        { criterion: "a", checks: ["TESTS", "tests"] },
        { criterion: "B", checks: ["made-up"] },
        { criterion: "C", checks: [] },
        { criterion: "D", checks: ["ci", "factory/verify", "none"] },
        // A tag in the text is not a tie: only the field ties, and E has no entry.
      ],
      ["lint", "tests", "ci"],
    );
    expect(tied.criteria).toEqual([
      "A. [checks: tests]",
      "B",
      "C [checks: none]",
      "D [checks: ci]",
      "E",
      "F",
    ]);
    expect(tied.dropped).toEqual(["made-up", "factory/verify", "none"]);
    expect(specCheckLinks("C [checks: none]")).toEqual({ text: "C", checks: [], uncovered: true });
  });

  it("never calls a triage tie Proven: it says the check triage named passed, and counts it apart", () => {
    const executed = executedChecks(SHA, ["tests"], [ran("tests", 0)]);
    const proof = proveCriteria(
      [
        { criterion: "A", met: true, evidence: "x" },
        { criterion: "B [checks: tests]", met: true, evidence: "x" },
        { criterion: "C", met: true, evidence: "x", checks: ["tests"] },
      ],
      executed,
      { checks: [] },
      { specCriteria: ["A [checks: tests]", "B [checks: none]", "C"], linksFrom: "triage" },
    );
    expect(proof.map((p) => [p.proven, p.linkedBy, whyNotProven(p)])).toEqual([
      [false, "triage", "passed tests, the check triage named (not checked by a person)"],
      [false, "triage", "not covered by a check"],
      [false, "reviewer", "only the reviewer named tests, and a reviewer's link proves nothing"],
    ]);
    expect(proof[0]).toMatchObject({
      provenBy: [],
      passedTriageCheck: ["tests"],
      fromTriage: true,
    });
    expect(proofCounts(proof)).toEqual({ proven: 0, total: 0, triage: { passed: 1, total: 3 } });
    // Auto-approval (ADR 0515) counts only a person's ties: never these.
    expect(everyCriterionProven(proof)).toBe(false);
    // The same ties in a person-approved spec do prove.
    const spec = proveCriteria(
      [{ criterion: "A", met: true, evidence: "x" }],
      executed,
      { checks: [] },
      { specCriteria: ["A [checks: tests]"] },
    );
    expect(spec[0]).toMatchObject({ proven: true, provenBy: ["tests"], linkedBy: "spec" });
    expect(proofCounts(spec)).toEqual({ proven: 1, total: 1 });
    expect(everyCriterionProven(spec)).toBe(true);
  });

  it("writes factory/verify's count of person-proven criteria apart from triage's", () => {
    const packet = assemblePacket({
      headSha: SHA,
      evidence: {
        ...reviewerFailing,
        checks: [],
        criteria: [
          { criterion: "A", met: true, evidence: "x" },
          { criterion: "B", met: true, evidence: "x" },
        ],
      },
      ci: green,
      files: [],
      sameModelAsImplementer: false,
      hostChecks: true,
      declaredChecks: ["tests"],
      checksRun: [ran("tests", 0)],
      specCriteria: ["A [checks: tests]", "B"],
      linksFrom: "triage",
    });
    expect(packet.sections.proven).toMatchObject({
      proven: 0,
      total: 0,
      triage: { passed: 1, total: 2 },
    });
    const out = verifyCheckOutput({
      evidencePass: packet.evidencePass,
      evidenceReasons: packet.evidenceReasons,
      warnings: packet.warnings,
      riskFlags: [],
      ci: green,
      workItem: { number: 7, title: "x" },
      ...storedProof(packet.sections),
    }).summary;
    expect(out).not.toContain("Criteria proven by an executed check");
    expect(out).toContain(
      "Criteria that passed the check triage named (not checked by a person, not proven): 1/2",
    );
    expect(out).toContain(
      "- Not proven: A (passed tests, the check triage named (not checked by a person))",
    );
  });

  it("never proves a criterion by a setup check: install and build by name, or proves: false", () => {
    // The probe: "Admin can revoke tokens [checks: install]" with install passing.
    const executed = executedChecks(
      SHA,
      ["install", "build", "e2e", "tests"],
      [
        { ...ran("install", 0), command: "pnpm install --frozen-lockfile" },
        ran("build", 0),
        ran("e2e", 0),
        ran("tests", 0),
      ],
    );
    const proof = proveCriteria(
      [
        { criterion: "Admin can revoke tokens", met: true, evidence: "x" },
        { criterion: "B", met: true, evidence: "x" },
        { criterion: "C", met: true, evidence: "x" },
        { criterion: "D", met: true, evidence: "x" },
      ],
      executed,
      { checks: [] },
      {
        specCriteria: [
          "Admin can revoke tokens [checks: install]",
          "B [checks: build]",
          "C [checks: e2e]",
          "D [checks: tests]",
        ],
        declared: [{ name: "e2e", run: "pnpm e2e", proves: false }, "tests"],
      },
    );
    expect(proof.map((p) => [p.proven, p.notCounted])).toEqual([
      [false, ["install"]],
      [false, ["build"]],
      [false, ["e2e"]],
      [true, []],
    ]);
    expect(whyNotProven(proof[0] as (typeof proof)[number])).toMatch(
      /^install can't prove a criterion \(a setup or static check/,
    );
    expect(checkProves("tests", "pnpm test")).toBe(true);
    expect(checkProves("deps", "npm ci")).toBe(false);
    expect(checkProves("verify", "./run.sh")).toBe(false); // not known to run tests
    expect(checkProves("verify", "./run.sh", true)).toBe(true); // the config says so
    expect(checkProves("lint", "pnpm lint", true)).toBe(false); // static, whatever it says
  });

  it("lists what triage may name: declared checks, then required CI, never factory/verify; no check is called none", () => {
    const policy = parsed({
      ...WITH_CHECKS,
      protection: { requiredChecks: ["ci", "factory/verify", "TESTS"] },
    });
    // Only checks that can prove are offered: not lint (static), not install or build (setup).
    expect(provableChecks(policy, null)).toEqual(["tests", "ci"]);
    const setup = parsed({
      ...POLICY,
      checks: [
        { name: "install", run: "pnpm install --frozen-lockfile" },
        { name: "build", run: "pnpm build" },
        { name: "smoke", run: "./smoke.sh", proves: true },
        { name: "unit", run: "pnpm vitest run", proves: false },
      ],
      protection: { requiredChecks: ["ci", "build"] },
    });
    expect(provableChecks(setup, null)).toEqual(["smoke", "ci"]);
    expect(
      parseProjectPolicy(JSON.stringify({ ...POLICY, checks: [{ name: "None", run: "x" }] })).ok,
    ).toBe(false);
  });

  it("says why a criterion is not proven", () => {
    const p = {
      proven: false,
      provenBy: [],
      unproven: [],
      notCounted: [],
      linkedBy: "spec" as const,
    };
    expect(whyNotProven(p)).toBe("no check is named for this");
    expect(whyNotProven({ ...p, unproven: ["tests"] })).toBe("tests didn't pass on this commit");
    expect(whyNotProven({ ...p, notCounted: ["lint"] })).toMatch(/^lint can't prove a criterion/);
    expect(whyNotProven({ ...p, notCounted: ["tests"], linkedBy: "reviewer" })).toMatch(
      /^only the reviewer named tests/,
    );
    expect(whyNotProven({ ...p, proven: true, provenBy: ["tests"] })).toBe("");
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
    // Letting a check prove criteria it didn't (proves: true) loosens; the reverse tightens.
    const setup = { name: "ui-check", run: "./run.sh" };
    const off = parsed({ ...WITH_CHECKS, checks: [...WITH_CHECKS.checks, setup] });
    const on = parsed({
      ...WITH_CHECKS,
      checks: [...WITH_CHECKS.checks, { ...setup, proves: true }],
    });
    expect(policyImpact(off, on, floor).class).toBe("loosens");
    expect(policyImpact(on, off, floor).class).toBe("tightens");
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
