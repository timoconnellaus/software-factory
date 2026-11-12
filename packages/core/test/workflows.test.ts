// Spec 09 M2: workflows and agents in the config (ADR 0371, 0372).
import { describe, expect, it } from "vitest";
import { parseFloor, parseProjectPolicy, policyImpact } from "../src/index.ts";
import { call, FOREMAN, newItem, ok, POLICY, refusal, world } from "./helpers.ts";

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

describe("workItem.setWorkflow (criterion 5)", () => {
  it("changes the workflow before build, and refuses after", async () => {
    const w = await world(doc());
    const item = await newItem(w);
    const set = await ok<{ workflow: string }>(
      "workItem.setWorkflow",
      { workItemId: item.workItemId, workflow: "ship a feature" },
      w.human,
    );
    expect(set.workflow).toBe("Ship a feature");
    const missing = await refusal(
      call("workItem.setWorkflow", { workItemId: item.workItemId, workflow: "Nope" }, w.human),
    );
    expect(missing.code).toBe("not_found");
    const agent = await refusal(
      call("workItem.setWorkflow", { workItemId: item.workItemId, workflow: null }, FOREMAN),
    );
    expect(agent.code).toBe("forbidden");
    await ok("workItem.enterStage", { workItemId: item.workItemId, stage: "build" }, FOREMAN);
    const late = await refusal(
      call("workItem.setWorkflow", { workItemId: item.workItemId, workflow: null }, w.human),
    );
    expect(late.code).toBe("conflict");
  });

  it("records triage's pick, falling back to the skeleton for an unknown name", async () => {
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
    expect(r.workflow).toBe("Ship a feature");
    const other = await newItem(w, "Other");
    const r2 = await ok<{ workflow: string | null }>(
      "workItem.triage",
      { workItemId: other.workItemId, result: { size: "small", reason: "tiny", workflow: "Nope" } },
      FOREMAN,
    );
    expect(r2.workflow).toBeNull();
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
