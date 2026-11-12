// Spec 09 M2: workflows fill the skeleton's slots (Workflow v6, ADR 0371); agents are
// harness-neutral and pick a model tier (ADR 0372).
import { resolveModel } from "@software-factory/core";
import { SOFTWARE } from "@software-factory/core/stages";
import { describe, expect, it } from "vitest";
import {
  definitionFor,
  expectSendBacksAsDefined,
  expectSlotStepsAsDefined,
  expectStagesAsDefined,
} from "./definition.ts";
import {
  all,
  BALANCED,
  build,
  first,
  gateOpen,
  itemStatus,
  ok,
  runStage,
  triage,
  verifyPass,
  world,
} from "./helpers.ts";

const POLICY = {
  ...BALANCED,
  agents: [
    { name: "Security", role: "review", tier: "light", instructions: "Look hard at auth." },
    { name: "Builder", role: "implement", tier: "light", instructions: "Run pnpm test first." },
  ],
  workflows: [
    {
      name: "Ship a feature",
      description: "New behaviour",
      slots: {
        beforeVerify: [
          { id: "security", kind: "work", name: "Security review", agent: "Security" },
        ],
        afterVerify: [{ id: "design", kind: "gate", name: "Design sign-off" }],
      },
      core: { build: "Builder" },
    },
    {
      name: "Big only",
      slots: {
        beforeVerify: [
          {
            id: "arch",
            kind: "work",
            name: "Architecture review",
            agent: "Security",
            when: { sizeAtLeast: "medium" },
          },
        ],
      },
    },
  ],
};

async function create(w: Awaited<ReturnType<typeof world>>, title = "Add dark mode") {
  return ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
}

describe("workflows (spec 09 M2)", () => {
  it("runs a work step before verify, sends back on its verdict, then holds at a gate step", async () => {
    // The project runs one workflow (ADR 0492): triage isn't asked to pick, and its pick is ignored.
    const w = await world({ ...POLICY, workflow: "Ship a feature" });
    const item = await create(w);
    const triaged = await runStage(w, item.workItemId, "triage", (job) => {
      expect(job.harness.prompt).not.toContain("Ship a feature: New behaviour");
      return triage("small", { workflow: "Big only", workflowReason: "ignored" });
    });
    expect(triaged.stage).toBe("triage");

    // The build agent's tier and instructions.
    const b1 = await runStage(w, item.workItemId, "build", (job) => {
      expect(job.harness.model).toBe(resolveModel("implement", {}, "light"));
      expect(job.harness.prompt).toContain("Run pnpm test first.");
      return build();
    });
    expect(b1.stage).toBe("build");

    // The security step runs as a read-only job before verify, and sends the item back.
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.step).toMatchObject({ workflow: "Ship a feature", id: "security" });
      expect(job.harness.prompt).toContain("Look hard at auth.");
      expect(job.harness.model).toBe(resolveModel("review", {}, "light"));
      return {
        result: {
          verdict: "sendBack",
          summary: "Token in a log line",
          notes: "Drop the token from the log",
        },
      };
    });
    await runStage(w, item.workItemId, "build", (job) => {
      expect(job.harness.prompt).toContain("Drop the token from the log");
      return build(["src/theme.ts", "src/log.ts"]);
    });
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.step).toBeDefined();
      return { result: { verdict: "pass", summary: "Clean now" } };
    });
    // The real verify (no step context), then the gate step.
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.step).toBeUndefined();
      return verifyPass;
    });
    const gate = await gateOpen(item.workItemId, "approval");
    const pa = await first<{ operation: string; assignee_user_id: string }>(
      "SELECT operation, assignee_user_id FROM core_pending_actions WHERE id = ?",
      gate.id,
    );
    expect(pa).toMatchObject({ operation: "workflow.gate", assignee_user_id: w.userId });
    await ok("approval.decide", { pendingActionId: gate.id, decision: "approved" }, w.human);

    await gateOpen(item.workItemId, "merge");
    await ok("review.merge", { workItemId: item.workItemId, openedFullDiff: false }, w.human);
    await itemStatus(item.workItemId, "done");

    // The slot steps ran as the compiled definition's slot stages say, and the agent check's
    // send-back went to its builder (spec 52 PR (a)).
    const { def, policy } = definitionFor({ ...POLICY, workflow: "Ship a feature" }, "change");
    expect(await expectSlotStepsAsDefined(item.workItemId, def, policy, "small", [])).toBe(2);
    await expectStagesAsDefined(item.workItemId, def, "small");
    await expectSendBacksAsDefined(item.workItemId, def);
    const recorded = await all<{ result: string }>(
      "SELECT result FROM core_audit WHERE work_item_id = ? AND operation = 'workflow.record' ORDER BY at, rowid",
      item.workItemId,
    );
    expect(recorded).toHaveLength(2);
    const row = await first<{ workflow: string; workflow_reason: string }>(
      "SELECT workflow, workflow_reason FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row).toMatchObject({
      workflow: "Ship a feature",
      workflow_reason: "the project's workflow",
    });
  });

  it("skips a step whose condition doesn't hold, and records the skip", async () => {
    const w = await world({ ...POLICY, workflow: "Big only" });
    const item = await create(w, "Fix a typo");
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => build());
    // Straight to the real verify: the architecture step is for medium work and up.
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.step).toBeUndefined();
      return verifyPass;
    });
    await gateOpen(item.workItemId, "merge");
    const audit = await all<{ input: string }>(
      "SELECT input FROM core_audit WHERE work_item_id = ? AND operation = 'workflow.record'",
      item.workItemId,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.input ?? "{}")).toMatchObject({
      outcome: "skipped",
      stepId: "arch",
    });
  });

  it("runs the skeleton alone for a project with no workflow, with the default Builder", async () => {
    // No workflows defined (a config that defines some must name one: ADR 0492 fails it closed).
    const w = await world({ ...POLICY, workflows: [] });
    const item = await create(w);
    // Triage's pick is ignored (ADR 0492): the project names no workflow.
    await runStage(w, item.workItemId, "triage", () =>
      triage("small", { workflow: "Ship a feature" }),
    );
    await runStage(w, item.workItemId, "build", (job) => {
      // No workflow: the build uses the agent called Builder (ADR 0372), light here.
      expect(job.harness.model).toBe(resolveModel("implement", {}, "light"));
      expect(job.harness.prompt).toContain("Run pnpm test first.");
      return build();
    });
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.step).toBeUndefined();
      return verifyPass;
    });
    const row = await first<{ workflow: string | null; workflow_reason: string }>(
      "SELECT workflow, workflow_reason FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row?.workflow).toBeNull();
    expect(row?.workflow_reason).toBeNull();
  });
});

describe("the default builder", () => {
  it("leaves the build on the standard tier when the project has no Builder agent", async () => {
    const w = await world(BALANCED);
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", (job) => {
      expect(job.harness.model).toBe(resolveModel("implement"));
      return build();
    });
  });

  it("runs a project's org workflow (spec 52 PR (d)): the org's check, with the org agent's instructions", async () => {
    const w = await world({ ...BALANCED, workflow: "wf_ship_it" });
    await ok(
      "agent.save",
      {
        orgId: w.orgId,
        baseVersion: 0,
        agent: {
          name: "Security",
          role: "review",
          tier: "light",
          instructions: "Org: check auth.",
        },
      },
      w.human,
    );
    await ok(
      "workflow.save",
      {
        orgId: w.orgId,
        baseVersion: 1,
        workflow: {
          ...SOFTWARE,
          id: "wf_ship_it",
          name: "Ship it",
          template: { id: SOFTWARE.id, version: 1 },
          stages: [
            ...SOFTWARE.stages.slice(0, 3),
            {
              id: "security",
              type: "agent-check",
              typeVersion: 1,
              name: "Security review",
              phase: "delivery",
              settings: { instructions: "Look at the token handling." },
              agent: "Security",
            },
            ...SOFTWARE.stages.slice(3),
          ],
        },
      },
      w.human,
    );
    const item = await create(w);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => build());
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.step).toMatchObject({ workflow: "wf_ship_it", id: "security" });
      expect(job.harness.prompt).toContain("Org: check auth.");
      expect(job.harness.prompt).toContain("Look at the token handling.");
      return { result: { verdict: "pass", summary: "Fine" } };
    });
    const row = await first<{ workflow: string; org_config_version: number }>(
      "SELECT workflow, org_config_version FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row).toEqual({ workflow: "wf_ship_it", org_config_version: 2 });
  });
});
