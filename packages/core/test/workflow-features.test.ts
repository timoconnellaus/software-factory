// The Workflow's feature table (coordinator's rule, 2026-11-12): a row per version, never `>= N`.
import { describe, expect, it } from "vitest";
import { has, WORKFLOW_FEATURES, WORKFLOW_VERSION_FEATURES } from "../src/index.ts";

describe("Workflow features per version", () => {
  it("has a row for every version, each adding to the one before, and nothing for an unknown one", () => {
    const versions = Object.keys(WORKFLOW_VERSION_FEATURES).map(Number);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 11, 12]); // v8–v10: other builds' numbers
    expect([...(WORKFLOW_VERSION_FEATURES[1] ?? [])]).toEqual([]);
    expect([...(WORKFLOW_VERSION_FEATURES[12] ?? [])]).toEqual([...WORKFLOW_FEATURES]);
    expect(has(null, "verify-packet")).toBe(false);
    expect(has(undefined, "verify-packet")).toBe(false);
    expect(has(99, "verify-packet")).toBe(false);
  });

  it("answers exactly what the `version >= N` checks it replaced answered, for v1 to v7", () => {
    // The thresholds the Workflow compared against before the table (work-item.ts on main).
    const since = {
      "verify-packet": 2,
      conflicts: 3,
      "merge-queue": 4,
      "planning-spec": 5,
      "workflow-plan": 6,
      "release-wait": 7,
      "babysitter-delivery": 11,
      "reverify-on-withdrawal": 12,
    } as const;
    expect(Object.keys(since).sort()).toEqual([...WORKFLOW_FEATURES].sort());
    for (let v = 1; v <= 7; v++) {
      for (const f of WORKFLOW_FEATURES) expect(has(v, f), `v${v} ${f}`).toBe(v >= since[f]);
    }
  });
});
