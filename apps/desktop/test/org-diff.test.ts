// Every field an org change touches is shown before an approver decides (review of #159).
import { describe, expect, it, vi } from "vitest";
import { agentDiff, workflowDiff } from "../src/mainview/lib/org-diff.ts";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const stage = (over: Record<string, unknown> = {}) => ({
  id: "review",
  name: "Reviewer",
  type: "agent-check",
  phase: "delivery",
  settings: {},
  ...over,
});

describe("workflowDiff", () => {
  it("shows a stage's agent, type, phase, condition and settings", () => {
    const before = { name: "Software", stages: [stage()] };
    for (const [field, value] of [
      ["agent", "Writer"],
      ["type", "checks"],
      ["phase", "shaping"],
      ["when", { domain: "docs" }],
      ["settings", { strict: false }],
    ] as const) {
      const rows = workflowDiff(before, { name: "Software", stages: [stage({ [field]: value })] });
      expect(
        rows.map((r) => r.label),
        field,
      ).toContain(`Reviewer: ${field}`);
    }
  });

  it("shows a stage added with its settings, a stage removed, and a new order", () => {
    const a = stage();
    const b = stage({ id: "build", name: "Build", type: "build", settings: { retryLimit: 2 } });
    const added = workflowDiff({ stages: [a] }, { stages: [a, b] });
    expect(added).toContainEqual({
      label: "Build: settings (new stage)",
      was: "none",
      now: '{"retryLimit":2}',
    });
    expect(workflowDiff({ stages: [a, b] }, { stages: [b] }).map((r) => r.label)).toContain(
      "Reviewer (removed)",
    );
    expect(workflowDiff({ stages: [a, b] }, { stages: [b, a] })).toContainEqual({
      label: "Stages",
      was: "Reviewer → Build",
      now: "Build → Reviewer",
    });
  });
});

describe("agentDiff", () => {
  it("shows every field, capabilities included", () => {
    const rows = agentDiff(
      { name: "Critic", role: "review", requires: [] },
      { name: "Critic", role: "review", requires: ["browser"] },
    );
    expect(rows).toEqual([{ label: "requires", was: "[]", now: '["browser"]' }]);
  });
});

describe("a change the screen can't show", () => {
  it("can't be approved when the engine sees a change but no field differs", async () => {
    const { cannotApproveOrg } = await import("../src/mainview/routes/factory.org.tsx");
    const same = { id: "wf_x", stages: [] };
    const p = {
      pendingActionId: "pa_1",
      operation: "workflow.save",
      note: null,
      by: null,
      createdAt: "",
      baseVersion: 4,
      proposal: same,
      current: same,
      toVersion: null,
      impact: {
        class: "loosens" as const,
        changes: [{ path: "x", class: "loosens" as const, summary: "Something" }],
      },
    };
    expect(cannotApproveOrg(p, 4)).toMatch(/can't show/);
  });
});
