// Spec 51 PR B (ADR 0501): checks the factory runs itself, and criteria proven only by them.
import { describe, expect, it } from "vitest";
import {
  assemblePacket,
  declaredChecks,
  executedChecks,
  FOREMAN,
  parseFloor,
  parseProjectPolicy,
  policyImpact,
  proveCriteria,
  summarizeCi,
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

  it("marks a criterion proven only by a linked check that passed, never by the reviewer's word", () => {
    const executed = executedChecks(SHA, ["tests", "lint"], [ran("tests", 0), ran("lint", 1)]);
    const ci = summarizeCi(
      [
        {
          id: "1",
          name: "e2e",
          status: "completed",
          conclusion: "success",
          appSlug: "gh",
          url: null,
        },
        {
          id: "2",
          name: "docs",
          status: "completed",
          conclusion: "skipped",
          appSlug: "gh",
          url: null,
        },
      ],
      "factory",
    );
    const proof = proveCriteria(
      [
        { criterion: "A", met: true, evidence: "unit", checks: ["tests"] },
        { criterion: "B", met: true, evidence: "e2e", checks: ["E2E"] },
        { criterion: "C", met: true, evidence: "I read the code" },
        { criterion: "D", met: true, evidence: "lint", checks: ["lint", "docs"] },
      ],
      executed,
      ci,
    );
    expect(proof.map((p) => [p.criterion, p.proven, p.provenBy, p.unproven])).toEqual([
      ["A", true, ["tests"], []],
      ["B", true, ["E2E"], []],
      ["C", false, [], []],
      ["D", false, [], ["lint", "docs"]],
    ]);
    expect(proof[2]?.opinion).toBe("I read the code");
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
      declaredChecks: ["tests"],
      checksRun: [ran("tests", 1)],
    });
    expect(packet.verdict).toBe("fail");
    expect(packet.reasons).toEqual(["check tests failed on ccccccc: `pnpm tests` exited 1"]);
    expect(packet.proof[0]?.proven).toBe(false);
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
