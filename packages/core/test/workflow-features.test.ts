// The Workflow's feature table (coordinator's rule, 2026-11-12): a row per version, never `>= N`.
import { describe, expect, it } from "vitest";
import { has, WORKFLOW_FEATURES, WORKFLOW_VERSION_FEATURES } from "../src/index.ts";

describe("Workflow features per version", () => {
  it("has a row for every version, each adding to the one before, and nothing for an unknown one", () => {
    const versions = Object.keys(WORKFLOW_VERSION_FEATURES).map(Number);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect([...(WORKFLOW_VERSION_FEATURES[1] ?? [])]).toEqual([]);
    expect([...(WORKFLOW_VERSION_FEATURES[16] ?? [])]).toEqual([...WORKFLOW_FEATURES]);
    // v16 adds splits (spec 24); nothing earlier has them.
    expect(has(16, "splits")).toBe(true);
    expect(has(15, "splits")).toBe(false);
    // v13 is v12 and the tightening re-pin (spec 52, Q3).
    expect(has(13, "reverify-on-withdrawal")).toBe(true);
    expect(has(12, "repin-tightening")).toBe(false);
    // v14 is v13 and a person's push re-verifying (ADR 0587).
    expect(has(14, "repin-tightening")).toBe(true);
    expect(has(13, "reverify-on-push")).toBe(false);
    // v11 is v10 and the babysitter: every feature of v9 and v10 stays on.
    expect(has(11, "triage-readiness")).toBe(true);
    expect(has(11, "spec-critic")).toBe(true);
    expect(has(10, "babysitter-delivery")).toBe(false);
    // v12 is v11 and the re-verify: every feature of v9 to v11 stays on.
    expect(has(12, "triage-readiness")).toBe(true);
    expect(has(12, "spec-critic")).toBe(true);
    expect(has(12, "babysitter-delivery")).toBe(true);
    expect(has(11, "reverify-on-withdrawal")).toBe(false);
    // v15 adds triage's ties to checks; nothing earlier has them.
    expect(has(15, "triage-ties")).toBe(true);
    expect(has(14, "triage-ties")).toBe(false);
    expect(has(7, "host-checks")).toBe(false);
    expect(has(8, "host-checks")).toBe(true);
    expect(has(8, "triage-readiness")).toBe(false);
    expect(has(9, "triage-readiness")).toBe(true);
    expect(has(9, "spec-critic")).toBe(false);
    expect(has(10, "spec-critic")).toBe(true);
    expect(has(null, "verify-packet")).toBe(false);
    expect(has(undefined, "verify-packet")).toBe(false);
    expect(has(99, "verify-packet")).toBe(false);
  });

  it("answers exactly what the `version >= N` checks it replaced answered, for v1 to v7 (host-checks, v8, came with the table)", () => {
    // The thresholds the Workflow compared against before the table (work-item.ts on main).
    const since = {
      "verify-packet": 2,
      conflicts: 3,
      "merge-queue": 4,
      "planning-spec": 5,
      "workflow-plan": 6,
      "release-wait": 7,
      "triage-readiness": 9,
      "spec-critic": 10,
      "babysitter-delivery": 11,
      "reverify-on-withdrawal": 12,
      "repin-tightening": 13,
      "reverify-on-push": 14,
      "triage-ties": 15,
    } as const;
    const older = WORKFLOW_FEATURES.filter((f): f is keyof typeof since => f in since);
    expect(older.sort()).toEqual(Object.keys(since).sort());
    for (let v = 1; v <= 7; v++) {
      for (const f of older) expect(has(v, f), `v${v} ${f}`).toBe(v >= since[f]);
    }
  });
});
