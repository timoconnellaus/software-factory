// The Workflow's feature table (coordinator's rule, 2026-11-12): a row per version, never `>= N`.
import { describe, expect, it } from "vitest";
import { has, WORKFLOW_FEATURES, WORKFLOW_VERSION_FEATURES } from "../src/index.ts";

describe("Workflow features per version", () => {
  it("has a row for every version, each adding to the one before, and nothing for an unknown one", () => {
    const versions = Object.keys(WORKFLOW_VERSION_FEATURES).map(Number);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...(WORKFLOW_VERSION_FEATURES[1] ?? [])]).toEqual([]);
    expect([...(WORKFLOW_VERSION_FEATURES[8] ?? [])]).toEqual([...WORKFLOW_FEATURES]);
    expect(has(7, "release-wait")).toBe(true);
    expect(has(7, "host-checks")).toBe(false);
    expect(has(8, "host-checks")).toBe(true);
    expect(has(null, "verify-packet")).toBe(false);
    expect(has(99, "verify-packet")).toBe(false);
  });
});
