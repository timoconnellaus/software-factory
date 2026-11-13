// Spec 52, Q3: a saved org workflow version that only tightens reaches a running item at its next
// stage boundary (`workItem.repinWorkflow`, called by the Workflow from v13); one that loosens
// anything never moves a running item.

import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import { parseProjectPolicy, resolveScope } from "../src/index.ts";
import {
  EMPTY_ORG_CONFIG,
  type OrgConfig,
  repinImpact,
  SOFTWARE,
  type StageInstance,
  type WorkflowDefinition,
} from "../src/stages/index.ts";
import { call, FOREMAN, first, newItem, ok, POLICY, rows, world } from "./helpers.ts";

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
const AGENT = {
  name: "Security",
  role: "review" as const,
  tier: "light" as const,
  instructions: "Be strict.",
  requires: [],
};
const withSetting = (
  def: WorkflowDefinition,
  id: string,
  settings: Record<string, unknown>,
): WorkflowDefinition => ({
  ...def,
  stages: def.stages.map((s) => (s.id === id ? { ...s, settings } : s)),
});
const policy = (overrides: Record<string, Record<string, unknown>> = {}) => {
  const p = parseProjectPolicy(
    JSON.stringify({ ...POLICY, workflow: SHIP.id, workflowOverrides: overrides }),
  );
  if (!p.ok) throw new Error(p.error);
  return p.policy;
};
const org = (workflow: WorkflowDefinition, instructions = AGENT.instructions): OrgConfig => ({
  ...EMPTY_ORG_CONFIG,
  agents: [{ ...AGENT, instructions }],
  workflows: [workflow],
});
const loosens = (i: { changes: { class: string }[] }) =>
  i.changes.some((c) => c.class === "loosens");

describe("repinImpact (pure)", () => {
  const at = (config: OrgConfig) => ({ config, approvals: {} });

  it("an added check or a stricter setting doesn't loosen", () => {
    const added: WorkflowDefinition = {
      ...SHIP,
      stages: [
        ...SHIP.stages.slice(0, 4),
        { ...SECURITY, id: "security_2", name: "Second look" },
        ...SHIP.stages.slice(4),
      ],
    };
    expect(loosens(repinImpact(policy(), at(org(SHIP)), at(org(added))))).toBe(false);
    const stricter = withSetting(SHIP, "spec", { requiredFrom: "small" });
    expect(loosens(repinImpact(policy(), at(org(SHIP)), at(org(stricter))))).toBe(false);
  });

  it("a dropped check, a softer judge or an unresolvable workflow loosens", () => {
    const dropped = { ...SHIP, stages: SOFTWARE.stages };
    expect(loosens(repinImpact(policy(), at(org(SHIP)), at(org(dropped))))).toBe(true);
    expect(loosens(repinImpact(policy(), at(org(SHIP)), at(org(SHIP, "Pass everything."))))).toBe(
      true,
    );
    expect(
      loosens(repinImpact(policy(), at(org(SHIP)), at({ ...EMPTY_ORG_CONFIG, agents: [AGENT] }))),
    ).toBe(true);
  });

  it("a project's looser override applies only with that version's approval", () => {
    // The project wants `large`; Ship it says `medium`. Approved under the pinned version only:
    // under the new one the stricter org value applies, so moving tightens.
    const p = policy({ spec: { requiredFrom: "large" } });
    const approved = { spec: { requiredFrom: "large" } };
    const moved = repinImpact(
      p,
      { config: org(SHIP), approvals: approved },
      { config: org(SHIP), approvals: {} },
    );
    expect(loosens(moved)).toBe(false);
    // The other way round (approved only under the new version) loosens.
    const back = repinImpact(
      p,
      { config: org(SHIP), approvals: {} },
      { config: org(SHIP), approvals: approved },
    );
    expect(loosens(back)).toBe(true);
  });
});

// ---- Through the operation ----

async function orgSave(w: W, base: number, workflow: WorkflowDefinition) {
  const r = await call("workflow.save", { orgId: w.orgId, baseVersion: base, workflow }, w.human);
  if (r.status === "pending")
    await ok(
      "approval.decide",
      { pendingActionId: r.pendingActionId, decision: "approved" },
      w.human,
    );
}

async function onShip(w: W) {
  await ok("agent.save", { orgId: w.orgId, baseVersion: 0, agent: { ...AGENT } }, w.human);
  await ok("workflow.save", { orgId: w.orgId, baseVersion: 1, workflow: SHIP }, w.human);
  const got = await ok<{ current: { version: number } | null }>(
    "config.get",
    { projectId: w.projectId },
    w.human,
  );
  await ok(
    "config.save",
    {
      projectId: w.projectId,
      baseVersion: got.current?.version ?? 0,
      policy: { ...POLICY, workflow: SHIP.id },
    },
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
const audits = (id: string) =>
  rows<{ diff: string }>(
    "SELECT diff FROM core_audit WHERE work_item_id = ? AND operation = 'workItem.repinWorkflow'",
    id,
  );

type Repin = { repinned: boolean; from: number | null; to: number | null; reason: string | null };

describe("workItem.repinWorkflow", () => {
  it("moves a running item onto a version that only tightens, once, and journals it", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    expect(await pinOf(item.workItemId)).toBe(2);
    // Nothing newer: stays, and no audit row (machine-frequency, ADR 0590).
    const same = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "verify #1" },
      FOREMAN,
    );
    expect(same.repinned).toBe(false);
    expect(await audits(item.workItemId)).toHaveLength(0);

    await orgSave(w, 2, withSetting(SHIP, "spec", { requiredFrom: "small" }));
    const moved = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "verify #1" },
      FOREMAN,
    );
    expect(moved).toMatchObject({ repinned: true, from: 2, to: 3 });
    expect(await pinOf(item.workItemId)).toBe(3);
    const journal = await audits(item.workItemId);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.diff).toMatch(/"workflow":"repinned"/);
    // Again at the next boundary: already current.
    const again = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "merge #1" },
      FOREMAN,
    );
    expect(again.repinned).toBe(false);
    expect(await audits(item.workItemId)).toHaveLength(1);
  });

  it("never moves a running item onto a version that loosens anything", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    // The org drops the Security check (an org admin approves the loosening for new items).
    await orgSave(w, 2, { ...SHIP, stages: SOFTWARE.stages });
    const stayed = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "verify #1" },
      FOREMAN,
    );
    expect(stayed.repinned).toBe(false);
    expect(stayed.reason).toMatch(/loosens against v2: Removes Security review/);
    expect(await pinOf(item.workItemId)).toBe(2);
    expect(await audits(item.workItemId)).toHaveLength(0);
    // A later version that also tightens: the item takes only that tightening, stage by stage, and
    // keeps the check the org dropped (review of #139, "adopt only the tightened parts").
    await orgSave(
      w,
      3,
      withSetting({ ...SHIP, stages: SOFTWARE.stages }, "spec", { requiredFrom: "small" }),
    );
    const still = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "merge #1" },
      FOREMAN,
    );
    expect(still).toMatchObject({ repinned: true, partial: true, from: 2, to: 4 });
    expect(await pinOf(item.workItemId)).toBe(2);
    const row = await first<{ org_config_floor: number | null }>(
      "SELECT org_config_floor FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row.org_config_floor).toBe(4);
    const scope = await resolveScope(createDb(env.DB), { workItemId: item.workItemId });
    // The stricter spec threshold applies, and the dropped Security check is still there.
    expect(scope.pinnedPolicy?.spec.requiredFrom).toBe("small");
    expect(scope.pinnedPolicy?.workflows[0]?.slots.beforeVerify.map((x) => x.id)).toEqual([
      "security",
    ]);
  });

  it("leaves an item that isn't on an org workflow, or isn't running, where it is", async () => {
    const w = await world();
    const plain = await newItem(w);
    const out = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: plain.workItemId, at: "verify #1" },
      FOREMAN,
    );
    expect(out).toMatchObject({ repinned: false, reason: "the item isn't on an org workflow" });

    await onShip(w);
    const backlog = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "backlog", projectId: w.projectId, title: "Later" },
      w.human,
    );
    const idle = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: backlog.workItemId, at: "verify #1" },
      FOREMAN,
    );
    expect(idle.repinned).toBe(false);
  });
});
