// Spec 52 PR (d): a project on an org workflow, with its overrides (Q5). Until the switch-over,
// today's engine runs it, through the config `effectivePolicy` resolves; an item runs under the org
// config version it pinned.
import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import type { InvokeResult } from "../src/index.ts";
import {
  clearOrgConfigCache,
  parseFloor,
  parseProjectPolicy,
  policyImpact,
  resolveScope,
} from "../src/index.ts";
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
import { call, first, newItem, ok, POLICY, refusal, rows, world } from "./helpers.ts";

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

  it("need an org workflow; a slot workflow already named like an org workflow id stays one", () => {
    const bad = (doc: unknown) => parseProjectPolicy(JSON.stringify(doc));
    expect(bad({ ...POLICY, workflowOverrides: { build: { retryLimit: 1 } } }).ok).toBe(false);
    expect(bad({ ...POLICY, workflow: "wf_ship_it" }).ok).toBe(true);
    // A config saved before PR (d) with a slot workflow called wf_x still parses and runs it.
    const legacy = parsed({ ...POLICY, workflows: [{ name: "wf_x" }], workflow: "wf_x" });
    expect(effectivePolicy(legacy, ORG)).toEqual({ ok: true, value: legacy });
  });

  it("apply as the stricter of the org's value and the override, unless the looser one was approved against the org's value", () => {
    const at = (overrides: Record<string, Record<string, unknown>>, approvals = {}) => {
      const r = applyOverrides(SHIP, overrides, { kind: "effective", approvals });
      if (!r.ok) throw new Error(r.error);
      return (id: string) => r.value.stages.find((s) => s.id === id)?.settings;
    };
    // Looser than the org (Spec from medium): the org's value, until that value is approved.
    expect(at({ spec: { requiredFrom: "large" } })("spec")).toEqual({ requiredFrom: "medium" });
    expect(
      at({ spec: { requiredFrom: "large" } }, { spec: { requiredFrom: "large" } })("spec"),
    ).toEqual({ requiredFrom: "large" });
    // An approval of another value approves nothing.
    expect(
      at({ spec: { requiredFrom: "large" } }, { spec: { requiredFrom: "small" } })("spec"),
    ).toEqual({ requiredFrom: "medium" });
    // Tighter applies as written; checks are the union of both.
    expect(at({ spec: { requiredFrom: "small" } })("spec")).toEqual({ requiredFrom: "small" });
    const tightOrg = {
      ...SHIP,
      stages: SHIP.stages.map((s) =>
        s.id === "verify" ? { ...s, settings: { requiredChecks: ["a", "b"] } } : s,
      ),
    };
    const r = applyOverrides(
      tightOrg,
      { verify: { requiredChecks: ["a", "c"] } },
      { kind: "effective", approvals: {} },
    );
    expect(r.ok && r.value.stages.find((s) => s.id === "verify")?.settings).toEqual({
      requiredChecks: ["a", "c", "b"],
    });
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
    const policy = parsed({
      ...POLICY,
      workflow: SHIP.id,
      workflowOverrides: { build: { retryLimit: 4 }, spec: { requiredFrom: "large" } },
    });
    // The looser spec threshold was approved for this org version.
    const approvals = { spec: { requiredFrom: "large" } };
    const eff = effectivePolicy(policy, ORG, approvals);
    if (!eff.ok) throw new Error(eff.error);
    expect(eff.value).toMatchObject({
      workflow: SHIP.id,
      retryLimit: 4,
      spec: { requiredFrom: "large" },
      autonomyPolicy: POLICY.autonomyPolicy,
      agents: ORG.agents,
    });
    const resolved = applyOverrides(SHIP, policy.workflowOverrides, {
      kind: "effective",
      approvals,
    });
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
    // Dropping an approved loosening override goes back to the org's value: a tightening.
    const large = onShip({ spec: { requiredFrom: "large" } });
    const approved = { spec: { requiredFrom: "large" } };
    expect(
      configImpact(policyImpact(large, onShip(), floor), large, onShip(), ORG, approved).class,
    ).toBe("tightens");
    // One that was never approved never applied: dropping it changes nothing.
    expect(impact(large, onShip()).class).toBe("neutral");
    // Keeping an unapproved one (or one approved for another version), while changing something
    // else, asks again.
    expect(
      impact(large, onShip({ spec: { requiredFrom: "large" }, build: { retryLimit: 4 } })).class,
    ).toBe("loosens");
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
    // The judge is compared by what it is told, not its name: the project's Security says "Be
    // strict"; an org Security told to approve everything is another judge (fourth review).
    const ownShip = parsed({
      ...POLICY,
      agents: [{ name: "Security", role: "review", tier: "light", instructions: "Be strict." }],
      workflows: [
        {
          name: "Feature",
          slots: {
            beforeVerify: [
              {
                id: "security",
                kind: "work",
                name: "Security review",
                agent: "Security",
                instructions: "Send back auth changes without tests.",
              },
            ],
          },
        },
      ],
      workflow: "Feature",
    });
    const lenient: OrgConfig = {
      ...ORG,
      agents: [
        { ...(ORG.agents[0] as OrgConfig["agents"][0]), instructions: "Approve everything." },
      ],
    };
    const swapped = configImpact(
      policyImpact(ownShip, onShip(), floor),
      ownShip,
      onShip(),
      lenient,
    );
    expect(swapped.class).toBe("loosens");
    expect(swapped.changes.some((c) => c.path === "workflow.stages.security.agent")).toBe(true);
    // The same judge, told the same thing, under the org: the move is neutral.
    expect(configImpact(policyImpact(ownShip, onShip(), floor), ownShip, onShip(), ORG).class).toBe(
      "neutral",
    );
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

// ---- The fourth review: stale overrides, who approves, stranded projects, cost ----

const withVerify = (settings: Record<string, unknown>): WorkflowDefinition => ({
  ...SHIP,
  stages: SHIP.stages.map((s) => (s.id === "verify" ? { ...s, settings } : s)),
});
const withSpec = (requiredFrom: string): WorkflowDefinition => ({
  ...SHIP,
  stages: SHIP.stages.map((s) => (s.id === "spec" ? { ...s, settings: { requiredFrom } } : s)),
});
const currentOrg = async (w: W) =>
  (
    await first<{ config_version: number }>(
      "SELECT config_version FROM core_organization WHERE id = ?",
      w.orgId,
    )
  ).config_version;
const storedConfig = async (w: W) =>
  JSON.parse(
    (
      await first<{ raw: string }>(
        "SELECT pp.raw FROM core_project_policies pp JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha WHERE p.id = ?",
        w.projectId,
      )
    ).raw,
  ) as Record<string, unknown>;

async function member(w: W, role: "member" | "admin") {
  const id = `usr_${role}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, role, `${id}@example.com`, `gh-${id}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(`mem_${id}`, w.orgId, id, role, now),
  ]);
  return { id, login: `gh-${id}`, actor: { type: "human" as const, id } };
}

describe("overrides never go stale", () => {
  it("an override equal to the org's value isn't stored, so the org's tightening reaches the project", async () => {
    const w = await world();
    await orgWorkflow(w);
    await ok(
      "workflow.save",
      { orgId: w.orgId, baseVersion: 2, workflow: withVerify({ requiredChecks: ["ci", "a"] }) },
      w.human,
    );
    expect(
      status(
        await saveConfig(w, {
          ...POLICY,
          workflow: SHIP.id,
          workflowOverrides: { verify: { requiredChecks: ["ci", "a"] } },
        }),
      ),
    ).toBe("ok");
    expect((await storedConfig(w)).workflowOverrides).toEqual({});
    await ok(
      "workflow.save",
      {
        orgId: w.orgId,
        baseVersion: 3,
        workflow: withVerify({ requiredChecks: ["ci", "a", "b"] }),
      },
      w.human,
    );
    const scope = await resolveScope(createDb(env.DB), { projectId: w.projectId });
    expect(scope.policy?.protection.requiredChecks).toEqual(["ci", "a", "b"]);
  });

  it("a draft can't bring its own approvals: an unapproved looser override applies as the org's value", async () => {
    const w = await world();
    await orgWorkflow(w);
    await saveConfig(w, { ...POLICY, workflow: SHIP.id });
    // Writing the approval into the draft doesn't make the loosening apply, or skip the approver.
    const forged = await saveConfig(w, {
      ...POLICY,
      workflow: SHIP.id,
      workflowOverrides: { spec: { requiredFrom: "large" } },
      workflowOverrideApprovals: { spec: { requiredFrom: { orgVersion: 2, orgValue: "medium" } } },
    });
    expect(forged.status).toBe("pending");
  });

  it("an imported .factory/policy.json can't carry approvals: a forged one is ignored", async () => {
    const w = await world();
    await orgWorkflow(w);
    // An admin imports a file (as a merged PR would bring it) that drops every required check and
    // claims an approval for it, in every shape a document could.
    await ok(
      "policy.sync",
      {
        projectId: w.projectId,
        ref: "refs/heads/main",
        sha: "f".repeat(40),
        content: JSON.stringify({
          ...POLICY,
          workflow: SHIP.id,
          workflowOverrides: { verify: { requiredChecks: [] } },
          workflowOverrideApprovals: {
            verify: { requiredChecks: { orgVersion: 2, orgValue: ["ci"], value: [] } },
          },
        }),
      },
      w.human,
    );
    const scope = await resolveScope(createDb(env.DB), { projectId: w.projectId });
    expect(scope.policy?.protection.requiredChecks).toEqual(["ci"]);
  });

  it("an approval for another org version doesn't count", async () => {
    const w = await world();
    await orgWorkflow(w);
    await saveConfig(w, {
      ...POLICY,
      workflow: SHIP.id,
      workflowOverrides: { verify: { requiredChecks: [] } },
    }).catch(() => null);
    // A pending save, then a row for an org version that isn't the current one (v1, not v2).
    const pa = await first<{ id: string } | null>(
      "SELECT id FROM core_pending_actions WHERE project_id = ? AND status = 'pending'",
      w.projectId,
    );
    if (pa) await ok("approval.decide", { pendingActionId: pa.id, decision: "approved" }, w.human);
    await env.DB.prepare("DELETE FROM core_override_approvals WHERE project_id = ?")
      .bind(w.projectId)
      .run();
    await env.DB.prepare(
      "INSERT INTO core_override_approvals (project_id, org_id, org_version, stage_id, setting, value, approved_by, approved_at) VALUES (?, ?, 1, 'verify', 'requiredChecks', '[]', ?, ?)",
    )
      .bind(w.projectId, w.orgId, w.userId, new Date().toISOString())
      .run();
    const scope = await resolveScope(createDb(env.DB), { projectId: w.projectId });
    expect(scope.policy?.protection.requiredChecks).toEqual(["ci"]);
  });

  it("an approved loosening holds until the org moves that value; then it lapses and the org's admins are told", async () => {
    const w = await world();
    await orgWorkflow(w);
    await saveConfig(w, { ...POLICY, workflow: SHIP.id });
    const looser = await saveConfig(w, {
      ...POLICY,
      workflow: SHIP.id,
      workflowOverrides: { spec: { requiredFrom: "large" } },
    });
    if (looser.status !== "pending") throw new Error(`expected pending, got ${looser.status}`);
    await ok(
      "approval.decide",
      { pendingActionId: looser.pendingActionId, decision: "approved" },
      w.human,
    );
    // The approval is the factory's record, for this org version and this value; not the document's.
    expect((await storedConfig(w)).workflowOverrideApprovals).toBeUndefined();
    expect(
      await rows(
        "SELECT org_version, stage_id, setting, value, approved_by FROM core_override_approvals WHERE project_id = ?",
        w.projectId,
      ),
    ).toEqual([
      {
        org_version: 2,
        stage_id: "spec",
        setting: "requiredFrom",
        value: '"large"',
        approved_by: w.userId,
      },
    ]);
    const db = createDb(env.DB);
    expect((await resolveScope(db, { projectId: w.projectId })).policy?.spec.requiredFrom).toBe(
      "large",
    );
    // An unrelated org save keeps it.
    await ok(
      "workflow.save",
      { orgId: w.orgId, baseVersion: 2, workflow: withVerify({ requiredChecks: ["ci"] }) },
      w.human,
    );
    expect((await resolveScope(db, { projectId: w.projectId })).policy?.spec.requiredFrom).toBe(
      "large",
    );
    // The org tightens the spec threshold past it: the stricter applies, and the admins hear.
    await ok(
      "workflow.save",
      {
        orgId: w.orgId,
        baseVersion: 3,
        workflow: {
          ...withVerify({ requiredChecks: ["ci"] }),
          stages: withVerify({ requiredChecks: ["ci"] }).stages.map((s) =>
            s.id === "spec" ? { ...s, settings: { requiredFrom: "small" } } : s,
          ),
        },
      },
      w.human,
    );
    expect((await resolveScope(db, { projectId: w.projectId })).policy?.spec.requiredFrom).toBe(
      "small",
    );
    const told = await first<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'workflow.overrideLapsed') > 0 AND instr(payload, ?) > 0",
      w.userId,
    );
    expect(told.payload).toMatch(/spec requiredFrom/);
  });
});

describe("a loosening of the org workflow is an org admin's to approve", () => {
  it("goes to the org's admins, not the project's approvers; an approver who isn't an admin can't approve it", async () => {
    const w = await world();
    await orgWorkflow(w);
    const approver = await member(w, "member");
    expect(
      status(await saveConfig(w, { ...POLICY, approvers: [approver.login], workflow: SHIP.id })),
    ).toBe("pending"); // naming approvers loosens (it was the org's admins)
    const pa0 = await first<{ id: string }>(
      "SELECT id FROM core_pending_actions WHERE project_id = ? AND status = 'pending'",
      w.projectId,
    );
    await ok("approval.decide", { pendingActionId: pa0.id, decision: "approved" }, w.human);
    const looser = await saveConfig(w, {
      ...POLICY,
      approvers: [approver.login],
      workflow: SHIP.id,
      workflowOverrides: { spec: { requiredFrom: "large" } },
    });
    if (looser.status !== "pending") throw new Error(`expected pending, got ${looser.status}`);
    const pa = await first<{ decider: string | null; assignee_user_id: string }>(
      "SELECT decider, assignee_user_id FROM core_pending_actions WHERE id = ?",
      looser.pendingActionId,
    );
    expect(pa).toEqual({ decider: "org-admin", assignee_user_id: w.userId });
    const refused = await refusal(
      call(
        "approval.decide",
        { pendingActionId: looser.pendingActionId, decision: "approved" },
        approver.actor,
      ),
    );
    expect(refused.code).toBe("forbidden");
    await ok(
      "approval.decide",
      { pendingActionId: looser.pendingActionId, decision: "approved" },
      w.human,
    );
  });
});

describe("org edits can't strand a project", () => {
  it("archiving a workflow a project runs is refused, naming the project", async () => {
    const w = await world();
    await orgWorkflow(w);
    await saveConfig(w, { ...POLICY, workflow: SHIP.id });
    const refused = await refusal(
      call("workflow.archive", { orgId: w.orgId, baseVersion: 2, workflowId: SHIP.id }, w.human),
    );
    expect(refused.message).toMatch(/Ship it is in use by Software factory/);
  });

  it("a save today's engine can't run is refused before it is saved, in plain words", async () => {
    const w = await world();
    await orgWorkflow(w);
    await saveConfig(w, { ...POLICY, workflow: SHIP.id });
    const refused = await refusal(
      call(
        "workflow.save",
        { orgId: w.orgId, baseVersion: 2, workflow: withVerify({ reviewer: false }) },
        w.human,
      ),
    );
    expect(refused.message).toMatch(
      /Software factory .*the factory can only run workflows shaped like Software until the reconciler takes over/,
    );
    expect(await currentOrg(w)).toBe(2);
    // The same workflow, used by no project, saves (after an admin approves the loosening).
    const w2 = await world();
    await orgWorkflow(w2);
    const saved = await call(
      "workflow.save",
      { orgId: w2.orgId, baseVersion: 2, workflow: withSpec("small") },
      w2.human,
    );
    expect(saved.status).toBe("ok");
  });
});

describe("cost: an org workflow is parsed once per isolate and version", () => {
  it("resolves from the cache, and a polled read doesn't resolve it at all", async () => {
    const w = await world();
    await orgWorkflow(w);
    await saveConfig(w, { ...POLICY, workflow: SHIP.id });
    const db = createDb(env.DB);
    clearOrgConfigCache();
    expect((await resolveScope(db, { projectId: w.projectId })).policyError).toBeNull();
    // Break the stored document: the cached parse is still used, so it was not read again.
    await env.DB.prepare("UPDATE core_org_configs SET raw = '{}' WHERE org_id = ? AND version = 2")
      .bind(w.orgId)
      .run();
    expect((await resolveScope(db, { projectId: w.projectId })).policyError).toBeNull();
    clearOrgConfigCache();
    expect((await resolveScope(db, { projectId: w.projectId })).policyError).toMatch(
      /doesn't validate/,
    );
    // A polled read skips it: the project's config as saved, nothing read or parsed.
    const skipped = await resolveScope(
      db,
      { projectId: w.projectId },
      { d1: env.DB, userId: w.userId, skipOrgWorkflow: true },
    );
    expect(skipped.policyError).toBeNull();
    expect(skipped.policy?.workflow).toBe(SHIP.id);
  });
});

describe("people read an org workflow's name", () => {
  it("project.workflow labels it by name, not its id", async () => {
    const w = await world();
    await orgWorkflow(w);
    await saveConfig(w, { ...POLICY, workflow: SHIP.id });
    const got = await ok<{ workflow: { name: string; label: string } | null }>(
      "project.workflow",
      { projectId: w.projectId },
      w.human,
    );
    expect(got.workflow).toMatchObject({ name: SHIP.id, label: "Ship it" });
  });
});
