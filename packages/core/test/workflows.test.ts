// Spec 09 M2: workflows and agents in the config (ADR 0371, 0372).
import { describe, expect, it } from "vitest";
import { parseFloor, parseProjectPolicy, policyImpact } from "../src/index.ts";
import { call, FOREMAN, first, newItem, ok, POLICY, refusal, world } from "./helpers.ts";

const agents = [
  { name: "Security", role: "review" },
  { name: "Builder", role: "implement", tier: "light" },
];
const feature = {
  name: "Ship a feature",
  slots: {
    beforeVerify: [{ id: "security", kind: "work", name: "Security review", agent: "Security" }],
    afterVerify: [{ id: "design", kind: "gate", name: "Design sign-off" }],
  },
  core: { build: "Builder" },
};
const doc = (extra: Record<string, unknown> = {}) => ({
  ...POLICY,
  agents,
  workflows: [feature],
  ...extra,
});
const errorOf = (value: unknown) => {
  const p = parseProjectPolicy(JSON.stringify(value));
  return p.ok ? null : p.error;
};

describe("workflows in the config", () => {
  it("accepts a workflow whose steps name real agents", () => {
    expect(errorOf(doc())).toBeNull();
  });

  it("has no way to remove the spec gate, verify or the merge gate (criterion 4)", () => {
    expect(errorOf(doc({ workflows: [{ ...feature, skipVerify: true }] }))).toMatch(/workflows/);
    expect(
      errorOf(doc({ workflows: [{ ...feature, slots: { ...feature.slots, replaceVerify: [] } }] })),
    ).toBeTruthy();
    expect(
      errorOf(doc({ workflows: [{ ...feature, core: { verify: "Security" } }] })),
    ).toBeTruthy();
  });

  it("refuses steps that don't add up", () => {
    const step = (s: Record<string, unknown>) =>
      doc({ workflows: [{ name: "W", slots: { beforeVerify: [{ id: "x", name: "X", ...s }] } }] });
    expect(errorOf(step({ kind: "work" }))).toMatch(/hands to an agent/);
    expect(errorOf(step({ kind: "work", agent: "Nobody" }))).toMatch(/no agent called "Nobody"/);
    // Work steps report; they never build.
    expect(errorOf(step({ kind: "work", agent: "Builder" }))).toMatch(/don't build/);
    expect(errorOf(step({ kind: "gate", agent: "Security" }))).toMatch(/hands to a person/);
    expect(errorOf(doc({ workflows: [{ ...feature, core: { build: "Security" } }] }))).toMatch(
      /needs role implement/,
    );
    expect(errorOf(doc({ workflows: [feature, feature] }))).toMatch(/two workflows/);
    expect(errorOf(doc({ modelRoles: { "implement.light": "x", wizard: "y" } }))).toMatch(
      /unknown model role "wizard"/,
    );
  });

  it("calls removing a gate step loosening and adding one tightening; work steps are practice", () => {
    const floor = parseFloor("");
    const p = (v: unknown) => {
      const r = parseProjectPolicy(JSON.stringify(v));
      if (!r.ok) throw new Error(r.error);
      return r.policy;
    };
    const noGate = doc({
      workflows: [{ ...feature, slots: { beforeVerify: feature.slots.beforeVerify } }],
    });
    expect(policyImpact(p(doc()), p(noGate), floor).class).toBe("loosens");
    expect(policyImpact(p(noGate), p(doc()), floor).class).toBe("tightens");
    const moreWork = doc({
      workflows: [
        {
          ...feature,
          slots: {
            ...feature.slots,
            afterSpec: [{ id: "docs", kind: "work", name: "Docs check", agent: "Security" }],
          },
        },
      ],
    });
    expect(policyImpact(p(doc()), p(moreWork), floor).class).toBe("neutral");
  });
});

describe("an item follows its project's workflow (ADR 0492)", () => {
  it("pins the project's workflow when the item is pulled; setWorkflow is refused", async () => {
    const w = await world(doc({ workflow: "Ship a feature" }));
    const item = await newItem(w);
    const row = await first<{ workflow: string | null; workflow_reason: string | null }>(
      "SELECT workflow, workflow_reason FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row).toEqual({ workflow: "Ship a feature", workflow_reason: "the project's workflow" });
    const refused = await refusal(
      call("workItem.setWorkflow", { workItemId: item.workItemId, workflow: null }, w.human),
    );
    expect(refused.code).toBe("conflict");
  });

  it("ignores triage's pick: the item keeps its project's workflow", async () => {
    const w = await world(doc());
    const item = await newItem(w);
    const r = await ok<{ workflow: string | null }>(
      "workItem.triage",
      {
        workItemId: item.workItemId,
        result: { size: "small", reason: "tiny", workflow: "SHIP A FEATURE" },
      },
      FOREMAN,
    );
    expect(r.workflow).toBeNull();
  });

  it("refuses a config naming a workflow it doesn't define", () => {
    expect(errorOf(doc({ workflow: "Nope" }))).toMatch(/no workflow called "Nope"/);
  });

  it("calls switching the project's workflow to one without its gate steps loosening", () => {
    const floor = parseFloor(undefined);
    const parse = (v: unknown) => {
      const p = parseProjectPolicy(JSON.stringify(v));
      if (!p.ok) throw new Error(p.error);
      return p.policy;
    };
    const quick = { name: "Quick fix", slots: {}, core: {} };
    const before = parse(doc({ workflows: [feature, quick], workflow: "Ship a feature" }));
    const after = parse(doc({ workflows: [feature, quick], workflow: "Quick fix" }));
    const loosened = policyImpact(before, after, floor).changes.filter(
      (c) => c.path === "workflow",
    );
    expect(loosened.map((c) => c.class)).toEqual(["loosens"]);
    const back = policyImpact(after, before, floor).changes.filter((c) => c.path === "workflow");
    expect(back.map((c) => c.class)).toEqual(["tightens"]);
  });
});

describe("workflow.gate", () => {
  it("always waits for a person, even when overrides would allow the agent", async () => {
    const w = await world(doc({ overrides: { agent: { plan: "allow" } } }));
    const item = await newItem(w);
    const r = await call(
      "workflow.gate",
      { workItemId: item.workItemId, workflow: "Ship a feature", stepId: "design", name: "Design" },
      FOREMAN,
    );
    expect(r.status).toBe("pending");
  });
});
