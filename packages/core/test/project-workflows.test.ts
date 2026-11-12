// Spec 52 PR (d): a project on an org workflow, with its overrides (Q5). Until the switch-over,
// today's engine runs it, through the config `effectivePolicy` resolves; an item runs under the org
// config version it pinned.
import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import type { InvokeResult } from "../src/index.ts";
import { parseFloor, parseProjectPolicy, policyImpact, resolveScope } from "../src/index.ts";
import {
  applyOverrides,
  compileProjectWorkflow,
  configImpact,
  EMPTY_ORG_CONFIG,
  effectivePolicy,
  type OrgConfig,
  planFromDefinition,
  runsOnToday,
  SOFTWARE,
  type StageInstance,
  type WorkflowDefinition,
} from "../src/stages/index.ts";
import { call, FOREMAN, first, newItem, ok, POLICY, refusal, world } from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;

const SECURITY: StageInstance = {
  id: "security",
  type: "agent-check",
  typeVersion: 1,
  name: "Security review",
  phase: "delivery",
  settings: { instructions: "Send back auth changes without tests." },
  agent: "Security",
};
const SHIP: WorkflowDefinition = {
  ...SOFTWARE,
  id: "wf_ship_it",
  name: "Ship it",
  template: { id: SOFTWARE.id, version: 1 },
  stages: [...SOFTWARE.stages.slice(0, 3), SECURITY, ...SOFTWARE.stages.slice(3)],
};
const ORG: OrgConfig = {
  ...EMPTY_ORG_CONFIG,
  agents: [
    {
      name: "Security",
      role: "review",
      tier: "light",
      instructions: "Be strict.",
      requires: [],
    },
  ],
  workflows: [SHIP],
};
const parsed = (doc: unknown) => {
  const p = parseProjectPolicy(JSON.stringify(doc));
  if (!p.ok) throw new Error(p.error);
  return p.policy;
};
const onShip = (overrides: Record<string, Record<string, unknown>> = {}) =>
  parsed({ ...POLICY, workflow: SHIP.id, workflowOverrides: overrides });

describe("overrides (Q5)", () => {
  it("apply only the settings each stage type lists, each valid", () => {
    const ok = applyOverrides(SHIP, { build: { retryLimit: 4 }, spec: { requiredFrom: "large" } });
    expect(ok.ok && ok.value.stages.find((s) => s.id === "build")?.settings).toEqual({
      retryLimit: 4,
    });
    expect(applyOverrides(SHIP, { verify: { reviewer: false } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /can't override Verify's reviewer \(only sections, requiredChecks\)/,
      ),
    });
    expect(applyOverrides(SHIP, { security: { instructions: "Pass." } })).toMatchObject({
      ok: false,
    });
    expect(applyOverrides(SHIP, { nope: { retryLimit: 1 } })).toMatchObject({ ok: false });
    expect(applyOverrides(SHIP, { build: { retryLimit: 99 } })).toMatchObject({ ok: false });
  });

  it("need an org workflow; a slot workflow can't take an org workflow's id as its name", () => {
    const bad = (doc: unknown) => parseProjectPolicy(JSON.stringify(doc));
    expect(bad({ ...POLICY, workflowOverrides: { build: { retryLimit: 1 } } }).ok).toBe(false);
    expect(bad({ ...POLICY, workflows: [{ name: "wf_x" }] }).ok).toBe(false);
    expect(bad({ ...POLICY, workflow: "wf_ship_it" }).ok).toBe(true);
  });
});

describe("what today's engine can run", () => {
  it("Software's stages in order with checks and decisions in its slots", () => {
    expect(runsOnToday(SOFTWARE)).toBeNull();
    expect(runsOnToday(SHIP)).toBeNull();
  });
  it("refuses what it would silently ignore", () => {
    const twice: WorkflowDefinition = {
      ...SHIP,
      stages: [...SHIP.stages, { ...(SOFTWARE.stages[3] as StageInstance), id: "verify-2" }],
    };
    expect(runsOnToday(twice)).toMatch(/isn't Software's stages in order/);
    const noReviewer: WorkflowDefinition = {
      ...SHIP,
      stages: SHIP.stages.map((s) =>
        s.id === "verify" ? { ...s, settings: { reviewer: false } } : s,
      ),
    };
    expect(runsOnToday(noReviewer)).toMatch(/Verify's reviewer isn't the default/);
    const early: WorkflowDefinition = {
      ...SHIP,
      stages: [SECURITY, ...SOFTWARE.stages],
    };
    expect(runsOnToday(early)).toMatch(/isn't in one of Software's slots/);
  });
});

describe("effectivePolicy", () => {
  it("is the config today's engine reads: the same plan as the org workflow's", () => {
    const policy = onShip({ build: { retryLimit: 4 }, spec: { requiredFrom: "large" } });
    const eff = effectivePolicy(policy, ORG);
    if (!eff.ok) throw new Error(eff.error);
    expect(eff.value).toMatchObject({
      workflow: SHIP.id,
      retryLimit: 4,
      spec: { requiredFrom: "large" },
      autonomyPolicy: POLICY.autonomyPolicy,
      agents: ORG.agents,
    });
    const resolved = applyOverrides(SHIP, policy.workflowOverrides);
    if (!resolved.ok) throw new Error(resolved.error);
    for (const size of ["small", "medium", "large"] as const)
      for (const domains of [[], ["auth"]])
        expect(
          planFromDefinition(
            compileProjectWorkflow(eff.value, eff.value.workflow),
            eff.value.agents,
            size,
            domains,
            eff.value.workflow,
          ),
        ).toEqual(planFromDefinition(resolved.value, ORG.agents, size, domains, SHIP.id));
  });
  it("fails closed on a workflow the org doesn't have, or one today's engine can't run", () => {
    expect(effectivePolicy(onShip(), EMPTY_ORG_CONFIG)).toMatchObject({ ok: false });
    const twice = { ...ORG, workflows: [{ ...SHIP, stages: [...SHIP.stages, SECURITY] }] };
    expect(effectivePolicy(onShip(), twice)).toMatchObject({ ok: false });
    // A project not on an org workflow is unchanged.
    const own = parsed(POLICY);
    expect(effectivePolicy(own, ORG)).toEqual({ ok: true, value: own });
  });
});

describe("the impact of a project's overrides and workflow choice", () => {
  const floor = parseFloor("");
  const impact = (before: ReturnType<typeof parsed>, after: ReturnType<typeof parsed>) =>
    configImpact(policyImpact(before, after, floor), before, after, ORG);
  it("an override that loosens against the org workflow's value loosens; one that tightens tightens", () => {
    expect(impact(onShip(), onShip({ spec: { requiredFrom: "large" } })).class).toBe("loosens");
    expect(impact(onShip(), onShip({ spec: { requiredFrom: "small" } })).class).toBe("tightens");
    expect(impact(onShip(), onShip({ verify: { sections: ["summary"] } })).class).toBe("loosens");
    // Dropping a loosening override goes back to the org's value: a tightening.
    expect(impact(onShip({ spec: { requiredFrom: "large" } }), onShip()).class).toBe("tightens");
  });
  it("without the org workflow in view, policyImpact fails closed", () => {
    expect(policyImpact(onShip(), onShip({ spec: { requiredFrom: "small" } }), floor).class).toBe(
      "loosens",
    );
  });
  it("switching to an org workflow compares the definitions: losing a project's check loosens", () => {
    const own = parsed({
      ...POLICY,
      agents: [{ name: "Security", role: "review", tier: "light", instructions: "Be strict." }],
      workflows: [
        {
          name: "Feature",
          slots: {
            beforeVerify: [
              { id: "security", kind: "work", name: "Security review", agent: "Security" },
            ],
            afterVerify: [{ id: "design", kind: "gate", name: "Design sign-off" }],
          },
        },
      ],
      workflow: "Feature",
    });
    expect(impact(own, onShip()).class).toBe("loosens");
    // From the skeleton alone to Ship it, which only adds a check: tightens.
    expect(impact(parsed(POLICY), onShip()).class).toBe("tightens");
  });
});

// ---- Through the operations: config.save, the scope, and an item's pin ----

async function orgWorkflow(w: W) {
  await ok("agent.save", { orgId: w.orgId, baseVersion: 0, agent: { ...ORG.agents[0] } }, w.human);
  return ok<{ version: number }>(
    "workflow.save",
    { orgId: w.orgId, baseVersion: 1, workflow: SHIP },
    w.human,
  );
}

async function saveConfig(w: W, policy: Record<string, unknown>) {
  const got = await ok<{ current: { version: number } | null }>(
    "config.get",
    { projectId: w.projectId },
    w.human,
  );
  return call<{ version: number; impact: { class: string } }>(
    "config.save",
    { projectId: w.projectId, baseVersion: got.current?.version ?? 0, policy },
    w.human,
  );
}

const status = (r: InvokeResult<unknown>) => r.status;

describe("a project on an org workflow", () => {
  it("config.save refuses a workflow the org doesn't have and an override the type doesn't list", async () => {
    const w = await world();
    await expect(saveConfig(w, { ...POLICY, workflow: "wf_nope" })).rejects.toThrow(
      /the org has no workflow wf_nope/,
    );
    await orgWorkflow(w);
    await expect(
      saveConfig(w, {
        ...POLICY,
        workflow: SHIP.id,
        workflowOverrides: { verify: { reviewer: false } },
      }),
    ).rejects.toThrow(/can't override Verify's reviewer/);
  });

  it("runs the org workflow, a loosening override waits for an approver, and an item keeps the version it pinned", async () => {
    const w = await world();
    await orgWorkflow(w);
    // Onto Ship it: the skeleton plus a check, so it applies at once.
    expect(status(await saveConfig(w, { ...POLICY, workflow: SHIP.id }))).toBe("ok");
    const db = createDb(env.DB);
    const scope = await resolveScope(db, { projectId: w.projectId });
    expect(scope.rawPolicy?.workflow).toBe(SHIP.id);
    expect(scope.policy?.workflows[0]?.slots.beforeVerify.map((s) => s.id)).toEqual(["security"]);
    expect(scope.policy?.agents.map((a) => a.name)).toEqual(["Security"]);
    // A looser spec threshold than the org's: self-modify.
    const looser = await saveConfig(w, {
      ...POLICY,
      workflow: SHIP.id,
      workflowOverrides: { spec: { requiredFrom: "large" } },
    });
    expect(looser.status).toBe("pending");
    // An item pins the org config version it is pulled under.
    const item = await newItem(w);
    const pinned = await first<{ org_config_version: number | null }>(
      "SELECT org_config_version FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(pinned.org_config_version).toBe(2);
    // The org drops the check (an org admin approves the loosening); the item keeps it.
    const dropped = await call(
      "workflow.save",
      { orgId: w.orgId, baseVersion: 2, workflow: { ...SHIP, stages: SOFTWARE.stages } },
      w.human,
    );
    if (dropped.status !== "pending") throw new Error(`expected pending, got ${dropped.status}`);
    await ok(
      "approval.decide",
      { pendingActionId: dropped.pendingActionId, decision: "approved" },
      w.human,
    );
    const now = await resolveScope(db, { workItemId: item.workItemId });
    expect(now.policy?.workflows[0]?.slots.beforeVerify).toEqual([]);
    expect(now.pinnedPolicy?.workflows[0]?.slots.beforeVerify.map((s) => s.id)).toEqual([
      "security",
    ]);
  });
});

describe("release takes the current version unless the shaping stages changed (Q4)", () => {
  async function shapedItem(w: W) {
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "backlog", projectId: w.projectId, title: "Shaped" },
      w.human,
    );
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    await ok("workItem.shaped", { workItemId: item.workItemId }, FOREMAN);
    return item.workItemId;
  }
  async function orgSave(w: W, base: number, workflow: WorkflowDefinition) {
    const r = await call("workflow.save", { orgId: w.orgId, baseVersion: base, workflow }, w.human);
    if (r.status === "pending")
      await ok(
        "approval.decide",
        { pendingActionId: r.pendingActionId, decision: "approved" },
        w.human,
      );
  }
  const pinOf = async (id: string) =>
    (
      await first<{ org_config_version: number | null }>(
        "SELECT org_config_version FROM core_work_items WHERE id = ?",
        id,
      )
    ).org_config_version;
  const withSetting = (id: string, settings: Record<string, unknown>): WorkflowDefinition => ({
    ...SHIP,
    stages: SHIP.stages.map((s) => (s.id === id ? { ...s, settings } : s)),
  });

  it("delivery-only changes: released under the current version", async () => {
    const w = await world();
    await orgWorkflow(w);
    expect((await saveConfig(w, { ...POLICY, workflow: SHIP.id })).status).toBe("ok");
    const id = await shapedItem(w);
    expect(await pinOf(id)).toBe(2);
    await orgSave(w, 2, withSetting("build", { retryLimit: 3 }));
    await ok("workItem.release", { workItemId: id }, w.human);
    expect(await pinOf(id)).toBe(3);
  });

  it("changed shaping stages: refused until the person chooses the shaped version", async () => {
    const w = await world();
    await orgWorkflow(w);
    expect((await saveConfig(w, { ...POLICY, workflow: SHIP.id })).status).toBe("ok");
    const id = await shapedItem(w);
    await orgSave(w, 2, withSetting("spec", { requiredFrom: "small" }));
    const e = await refusal(call("workItem.release", { workItemId: id }, w.human));
    expect(e.message).toMatch(
      /shaped under org config v2; its workflow's shaping stages changed in v3/,
    );
    await ok("workItem.release", { workItemId: id, underShapedVersion: true }, w.human);
    expect(await pinOf(id)).toBe(2);
  });
});
