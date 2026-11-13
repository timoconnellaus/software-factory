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
      now: JSON.stringify({ retryLimit: 2 }, null, 1),
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
    expect(rows).toEqual([
      { label: "requires", was: "[]", now: JSON.stringify(["browser"], null, 1) },
    ]);
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
    expect(cannotApproveOrg(p, 4)).toMatch(/changes nothing/);
  });
});

describe("round 3 of #159", () => {
  it("never cuts what it compares: a change past the 200th character reads different", async () => {
    const { unreadable } = await import("../src/mainview/lib/org-diff.ts");
    const long = "x".repeat(300);
    const rows = workflowDiff(
      { stages: [stage({ settings: { instructions: `${long}a` } })] },
      { stages: [stage({ settings: { instructions: `${long}b` } })] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.was).not.toBe(rows[0]?.now);
    expect(unreadable(rows)).toBe(false);
    expect(unreadable([{ label: "x", was: "same", now: "same" }])).toBe(true);
  });

  it("shows a stage type's version and the workflow's template", () => {
    const labels = workflowDiff(
      { template: { id: "wf_software", version: 1 }, stages: [stage({ typeVersion: 1 })] },
      { template: { id: "wf_software", version: 2 }, stages: [stage({ typeVersion: 2 })] },
    ).map((r) => r.label);
    expect(labels).toContain("Reviewer: typeVersion");
    expect(labels).toContain("Workflow template");
  });
});

describe("round 4 of #159", () => {
  it("shows a waiting rollback field by field, across workflows and agents", async () => {
    const { orgConfigDiff } = await import("../src/mainview/lib/org-diff.ts");
    const now = {
      workflows: [{ id: "wf_a", name: "A", stages: [stage()] }],
      agents: [{ name: "Critic", role: "review", instructions: "Strict." }],
    };
    const target = {
      workflows: [],
      agents: [{ name: "Critic", role: "review", instructions: "Lenient." }],
    };
    const rows = orgConfigDiff(now, target);
    expect(rows).toContainEqual({ label: "Workflow A", was: "present", now: "removed" });
    expect(rows).toContainEqual({
      label: "Agent Critic: instructions",
      was: "Strict.",
      now: "Lenient.",
    });
  });

  it("doesn't count a change of key order alone", () => {
    expect(
      workflowDiff(
        { stages: [stage({ settings: { a: 1, b: 2 } })] },
        { stages: [stage({ settings: { b: 2, a: 1 } })] },
      ),
    ).toEqual([]);
  });

  it("makes invisible and trailing-space changes visible, and marks where they differ", async () => {
    const { changedRegion } = await import("../src/mainview/lib/org-diff.ts");
    const zw = changedRegion("Pass only green builds.", "Pass only green\u200b builds.");
    expect(zw.was).toBe("");
    expect(zw.now).toBe("⟨U+200B⟩");
    const trailing = changedRegion("Be strict.", "Be strict. ");
    expect(trailing.now).toBe("·");
    const long = changedRegion(
      `${"x".repeat(500)}a${"y".repeat(500)}`,
      `${"x".repeat(500)}b${"y".repeat(500)}`,
    );
    expect(long.was).toBe("a");
    expect(long.now).toBe("b");
    expect(long.before.startsWith("…")).toBe(true);
  });
});
