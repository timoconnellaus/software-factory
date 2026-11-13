// Spec 52, Q3: a saved org workflow version that only tightens reaches a running item at its next
// stage boundary (`workItem.repinWorkflow`, called by the Workflow from v13); one that loosens
// anything never moves a running item.

import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import { invoke, parseProjectPolicy, resolveScope } from "../src/index.ts";
import {
  EMPTY_ORG_CONFIG,
  type OrgConfig,
  repinImpact,
  SOFTWARE,
  type StageInstance,
  type WorkflowDefinition,
} from "../src/stages/index.ts";
import { call, deps, FOREMAN, first, newItem, ok, POLICY, rows, world } from "./helpers.ts";

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
    expect(stayed.reason).toMatch(/loosens against what the item runs: Removes Security review/);
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
    const row = await first<{ org_config_adopted: string | null }>(
      "SELECT org_config_adopted FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row.org_config_adopted).toBe("[4]");
    const scope = await resolveScope(createDb(env.DB), { workItemId: item.workItemId });
    // The stricter spec threshold applies, and the dropped Security check is still there.
    expect(scope.pinnedPolicy?.spec.requiredFrom).toBe("small");
    expect(scope.pinnedPolicy?.workflows[0]?.slots.beforeVerify.map((x) => x.id)).toEqual([
      "security",
    ]);
  });

  it("a later version never takes away a tightening the item adopted (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    const E2E: StageInstance = { ...SECURITY, id: "e2e", name: "End-to-end check" };
    const adoptedOf = async () =>
      (
        await first<{ org_config_adopted: string | null }>(
          "SELECT org_config_adopted FROM core_work_items WHERE id = ?",
          item.workItemId,
        )
      ).org_config_adopted;
    // v3 drops Security and adds an e2e check: the item takes the e2e check only.
    await orgSave(w, 2, {
      ...SHIP,
      stages: [...SOFTWARE.stages.slice(0, 3), E2E, ...SOFTWARE.stages.slice(3)],
    });
    const first3 = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "verify #1" },
      FOREMAN,
    );
    expect(first3).toMatchObject({ repinned: true, partial: true, to: 3 });
    expect(await adoptedOf()).toBe("[3]");
    // v4 brings Security back without the e2e check and raises the spec threshold: against the pin
    // it only tightens, but against what the item runs it drops the e2e check. It takes only the
    // threshold, and keeps both checks.
    await orgSave(w, 3, withSetting(SHIP, "spec", { requiredFrom: "small" }));
    const then4 = await ok<Repin>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "verify #2" },
      FOREMAN,
    );
    expect(then4).toMatchObject({ repinned: true, partial: true, to: 4 });
    expect(await pinOf(item.workItemId)).toBe(2);
    expect(await adoptedOf()).toBe("[3,4]");
    const scope = await resolveScope(createDb(env.DB), { workItemId: item.workItemId });
    expect(scope.pinnedPolicy?.spec.requiredFrom).toBe("small");
    expect(scope.pinnedPolicy?.workflows[0]?.slots.beforeVerify.map((x) => x.id).sort()).toEqual([
      "e2e",
      "security",
    ]);
  });

  it("at the merge boundary only tightenings verify can act on are behind (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    // A spec threshold: passed for good, journaled, not re-verified.
    await orgSave(w, 2, withSetting(SHIP, "spec", { requiredFrom: "small" }));
    const spec = await ok<Repin & { behind: string[] }>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "merge #1" },
      FOREMAN,
    );
    expect(spec).toMatchObject({ repinned: true, behind: [] });
    expect((await audits(item.workItemId))[0]?.diff).toMatch(/"passed":\[/);
    // A check added before verify is behind (workflows.test.ts runs it at the merge boundary).
  });

  it("an adopted check is judged by its own version's agent, not an older one of the same name (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const agentSave = async (base: number, instructions: string) => {
      const r = await call(
        "agent.save",
        {
          orgId: w.orgId,
          baseVersion: base,
          agent: { name: "Scanner", role: "review", tier: "light", instructions },
        },
        w.human,
      );
      if (r.status === "pending")
        await ok(
          "approval.decide",
          { pendingActionId: r.pendingActionId, decision: "approved" },
          w.human,
        );
    };
    // v3: an agent nothing uses yet, which passes everything. The item pins v3.
    await agentSave(2, "Pass everything.");
    const item = await newItem(w);
    expect(await pinOf(item.workItemId)).toBe(3);
    // v4 rewrites it; v5 adds a check using it and drops Security (mixed: the check is adopted).
    await agentSave(3, "Block any secret.");
    const SCAN: StageInstance = { ...SECURITY, id: "scan", name: "Secret scan", agent: "Scanner" };
    await orgSave(w, 4, {
      ...SHIP,
      stages: [...SOFTWARE.stages.slice(0, 3), SCAN, ...SOFTWARE.stages.slice(3)],
    });
    const moved = await ok<Repin & { partial: boolean }>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "verify #1" },
      FOREMAN,
    );
    expect(moved).toMatchObject({ repinned: true, partial: true, to: 5 });
    const scope = await resolveScope(createDb(env.DB), { workItemId: item.workItemId });
    const p = scope.pinnedPolicy;
    const scan = p?.workflows[0]?.slots.beforeVerify.find((x) => x.id === "scan");
    const agent = p?.agents.find((a) => a.name.toLowerCase() === scan?.agent?.toLowerCase());
    expect(agent?.instructions).toBe("Block any secret.");
  });

  it("a version that swaps a required check isn't taken, and the approvers are told once (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    const checks = (list: string[]) => withSetting(SHIP, "verify", { requiredChecks: list });
    await orgSave(w, 2, checks(["ci", "y"]));
    expect(
      await ok<Repin>(
        "workItem.repinWorkflow",
        { workItemId: item.workItemId, at: "verify #1" },
        FOREMAN,
      ),
    ).toMatchObject({ repinned: true, to: 3 });
    // v4 swaps y for z: verify both tightens and loosens, so the item keeps y and isn't given z.
    await orgSave(w, 3, checks(["ci", "z"]));
    const kept = await ok<Repin & { skipped: string[]; noticed?: boolean }>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "verify #2" },
      FOREMAN,
    );
    expect(kept).toMatchObject({ repinned: false, noticed: true });
    expect(kept.skipped.length).toBeGreaterThan(0);
    const before = (await audits(item.workItemId)).length;
    const again = await ok<Repin & { noticed?: boolean }>(
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "merge #1" },
      FOREMAN,
    );
    expect(again.noticed).toBeUndefined();
    expect(await audits(item.workItemId)).toHaveLength(before);
    const told = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'workflow.notAdopted') > 0 AND instr(payload, ?) > 0",
      item.workItemId,
    );
    expect(told.length).toBeGreaterThan(0);
  });

  it("only the item's Workflow re-pins it (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    const r = await invoke(
      deps,
      "workItem.repinWorkflow",
      { workItemId: item.workItemId, at: "merge #1" },
      { actor: FOREMAN, origin: { surface: "mcp" } },
    ).catch((e: { code: string }) => e);
    expect(r).toMatchObject({ code: "forbidden" });
  });

  it("a decision gate added while an item's merge gate is open is told at that gate (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    const now = new Date().toISOString();
    await rows(
      `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, kind, operation, risk, actor_type, actor_id, input, status, assignee_user_id, created_at)
       VALUES (?, ?, ?, ?, 'merge', 'pr.merge', 'merge', 'agent', 'foreman', '{}', 'pending', ?, ?)`,
      `pa_${crypto.randomUUID().replaceAll("-", "")}`,
      w.orgId,
      w.projectId,
      item.workItemId,
      w.userId,
      now,
    );
    const DECIDE: StageInstance = {
      id: "design-ok",
      type: "decision",
      typeVersion: 1,
      name: "Design sign-off",
      phase: "delivery",
      settings: {},
    };
    await orgSave(w, 2, {
      ...SHIP,
      stages: [...SHIP.stages.slice(0, 4), DECIDE, ...SHIP.stages.slice(4)],
    });
    const told = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'workflow.gateNotApplied') > 0 AND instr(payload, ?) > 0",
      item.workItemId,
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toMatch(/adds Design sign-off; not applied to this item/);
  });

  it("an item whose workflow can't be read does no work on any Workflow row, and its owner is asked once (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    await rows(
      "UPDATE core_work_items SET org_config_adopted = '[99]' WHERE id = ?",
      item.workItemId,
    );
    const as = (op: string, input: Record<string, unknown>) =>
      invoke(deps, op, input, { actor: FOREMAN, origin: { surface: "workflow" } }).catch(
        (e: { code: string; message: string }) => e,
      );
    // A job for any stage: refused, whatever row the Workflow runs.
    const enqueue = await as("job.enqueue", {
      workItemId: item.workItemId,
      stage: "build",
      role: "implement",
      prompt: "Build it",
    });
    expect(enqueue).toMatchObject({ code: "workflow_unreadable" });
    // A merge, directly.
    const merge = await as("pr.merge", {
      workItemId: item.workItemId,
      headSha: "a".repeat(40),
      touchesFactoryConfig: false,
    });
    expect(merge).toMatchObject({ code: "workflow_unreadable" });
    // One blocking question for the owner, however many refusals.
    const asked = await rows<{ prompt: string; blocking: number }>(
      "SELECT prompt, blocking FROM core_questions WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(asked).toHaveLength(1);
    // No v17 Workflow parks this item, so its owner is told what happened and what to do, in plain
    // words (the parse detail goes in the question's context).
    expect(asked[0]).toMatchObject({ blocking: 0 });
    expect(asked[0]?.prompt).toMatch(
      /^This item's workflow version can't be read: a later org workflow version whose tightenings it took no longer reads\. .*start a new item for this work, or reopen this one\./,
    );
    // Reads, and what asks or ends it, still work; a person isn't refused.
    expect(
      await as("workItem.repinWorkflow", { workItemId: item.workItemId, at: "verify #1" }),
    ).toMatchObject({ status: "ok", output: { unreadable: expect.any(String) } });
    const seen = await ok<{ workflowError?: string; workflows: unknown[] }>(
      "workItem.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(seen.workflowError).toMatch(/adopted/);
    expect(seen.workflows).toEqual([]);
  });

  it("a transient read error is a retryable refusal, never 'unreadable' (review of #185)", async () => {
    const { workflowUnreadable } = await import("../src/unreadable.ts");
    const blip = new Proxy(
      {},
      {
        get() {
          throw new Error("D1_ERROR: network blip");
        },
      },
    );
    await expect(
      workflowUnreadable({ db: blip, scope: { workItemId: null } } as never, "wi_somewhere"),
    ).rejects.toMatchObject({ code: "unavailable" });
    // And with a healthy read, the same item reads.
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    const db = createDb(env.DB);
    expect(
      await workflowUnreadable({ db, scope: { workItemId: null } } as never, item.workItemId),
    ).toBeNull();
  });

  it("an item that ends (a row before 17) is told once, however often it's refused (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    await rows(
      "UPDATE core_work_items SET org_config_adopted = '[99]' WHERE id = ?",
      item.workItemId,
    );
    const as = (op: string, input: Record<string, unknown>) =>
      invoke(deps, op, input, { actor: FOREMAN, origin: { surface: "workflow" } }).catch(
        (e: { code: string }) => e,
      );
    const enqueue = {
      workItemId: item.workItemId,
      stage: "build",
      role: "implement",
      prompt: "Go",
    };
    await as("job.enqueue", enqueue);
    const [q] = await rows<{ id: string }>(
      "SELECT id FROM core_questions WHERE work_item_id = ? AND asked_by = 'workflow-unreadable'",
      item.workItemId,
    );
    await ok("question.answer", { questionId: q?.id, answer: "Understood" }, w.human);
    await as("job.enqueue", enqueue);
    expect(
      await rows(
        "SELECT id FROM core_questions WHERE work_item_id = ? AND asked_by = 'workflow-unreadable'",
        item.workItemId,
      ),
    ).toHaveLength(1);
  });

  it("an item that has ended is never asked, however often it's refused (seventh review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    await rows(
      "UPDATE core_work_items SET org_config_adopted = '[99]', status = 'failed' WHERE id = ?",
      item.workItemId,
    );
    const refused = await invoke(
      deps,
      "job.enqueue",
      { workItemId: item.workItemId, stage: "build", role: "implement", prompt: "Go" },
      { actor: FOREMAN, origin: { surface: "workflow" } },
    ).catch((e: { code: string }) => e);
    expect(refused).toMatchObject({ code: "workflow_unreadable" });
    expect(
      await rows("SELECT id FROM core_questions WHERE work_item_id = ?", item.workItemId),
    ).toEqual([]);
  });

  it("an item whose own pinned config doesn't parse fails closed too (review of #185)", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    await rows(
      "UPDATE core_work_items SET policy_sha = ? WHERE id = ?",
      "f".repeat(40),
      item.workItemId,
    );
    const scope = await resolveScope(createDb(env.DB), { workItemId: item.workItemId });
    expect(scope.pinnedError).toMatch(/the config the item started under can't be read/);
  });

  it("an adopted list that can't be resolved fails closed, never the pinned workflow alone", async () => {
    const w = await world();
    await onShip(w);
    const item = await newItem(w);
    await rows(
      "UPDATE core_work_items SET org_config_adopted = '[99]' WHERE id = ?",
      item.workItemId,
    );
    const scope = await resolveScope(createDb(env.DB), { workItemId: item.workItemId });
    expect(scope.pinnedPolicy).toBeNull();
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
