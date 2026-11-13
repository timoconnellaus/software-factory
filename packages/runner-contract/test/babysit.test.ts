// The `babysit` job kind in the runner contract (spec 53 §4, ADR 0620).
import { describe, expect, it } from "vitest";
import { babysitResultSchema, pushesRunBranch, stagePool } from "../src/index.ts";

describe("the babysit stage", () => {
  it("takes a light slot, and pushes its run branch only when it resolves a conflict", () => {
    expect(stagePool("babysit")).toBe("light");
    expect(pushesRunBranch({ stage: "build" })).toBe(true);
    expect(pushesRunBranch({ stage: "verify" })).toBe(false);
    expect(pushesRunBranch({ stage: "babysit", context: { reason: { kind: "conflict" } } })).toBe(
      true,
    );
    expect(
      pushesRunBranch({ stage: "babysit", context: { reason: { kind: "check-failed" } } }),
    ).toBe(false);
    expect(pushesRunBranch({ stage: "babysit" })).toBe(false);
  });

  it("hands back one verdict with a note, nothing else", () => {
    expect(
      babysitResultSchema.safeParse({ verdict: "flake", check: "ci", note: "ECONNRESET" }).success,
    ).toBe(true);
    expect(babysitResultSchema.safeParse({ verdict: "merge", note: "x" }).success).toBe(false);
    expect(babysitResultSchema.safeParse({ verdict: "resolved" }).success).toBe(false);
  });
});
