// What an org admin sees of a waiting org change before deciding it (review of #159): what it would
// save, what is there now, and the engine's classification; and a rollback's preview.
import { describe, expect, it } from "vitest";
import { call, ok, world } from "./helpers.ts";

type Got = {
  version: number;
  pending: {
    operation: string;
    baseVersion: number | null;
    proposal: Record<string, unknown> | null;
    current: Record<string, unknown> | null;
    impact: { class: string; changes: { summary: string }[] } | null;
  }[];
};

async function orgWithWorkflow() {
  const w = await world();
  const made = await ok<{ version: number; workflowId: string }>(
    "workflow.createFromTemplate",
    { orgId: w.orgId, baseVersion: 0, templateId: "wf_software", name: "Desk" },
    w.human,
  );
  const got = await ok<{ version: number; workflow: { stages: Record<string, unknown>[] } }>(
    "workflow.get",
    { orgId: w.orgId, workflowId: made.workflowId },
    w.human,
  );
  return { w, made, got };
}

describe("a waiting org change, as an approver sees it", () => {
  it("carries the proposal, the current workflow and the engine's classification", async () => {
    const { w, got } = await orgWithWorkflow();
    // Verify requires fewer checks.
    const looser = {
      ...got.workflow,
      stages: got.workflow.stages.map((s) =>
        s.type === "checks"
          ? { ...s, settings: { ...(s.settings as object), requiredChecks: [] } }
          : s,
      ),
    };
    const r = await call(
      "workflow.save",
      { orgId: w.orgId, baseVersion: got.version, workflow: looser },
      w.human,
    );
    expect(r.status).toBe("pending");
    const org = await ok<Got>("orgConfig.get", { orgId: w.orgId }, w.human);
    const p = org.pending[0];
    expect(p?.operation).toBe("workflow.save");
    expect(p?.baseVersion).toBe(got.version);
    expect(p?.proposal?.stages).toEqual(looser.stages);
    expect(p?.current?.stages).toHaveLength(got.workflow.stages.length);
    expect(p?.impact?.class).toBe("loosens");
  });

  it("previews a rollback against the current version", async () => {
    const { w, made } = await orgWithWorkflow();
    await ok(
      "workflow.archive",
      { orgId: w.orgId, baseVersion: made.version, workflowId: made.workflowId },
      w.human,
    );
    const preview = await ok<{
      impact: { class: string };
      before: { name: string }[];
      after: { name: string }[];
    }>("orgConfig.previewRollback", { orgId: w.orgId, toVersion: made.version }, w.human);
    expect(preview.before.map((x) => x.name)).not.toContain("Desk");
    expect(preview.after.map((x) => x.name)).toContain("Desk");
    expect(["loosens", "tightens", "neutral"]).toContain(preview.impact.class);
  });
});

describe("the rollback preview and agent saves are bound to a version (review of #159)", () => {
  it("names the version it compared against, and refuses a member of another org", async () => {
    const { w, made } = await orgWithWorkflow();
    await ok(
      "workflow.archive",
      { orgId: w.orgId, baseVersion: made.version, workflowId: made.workflowId },
      w.human,
    );
    const preview = await ok<{ currentVersion: number }>(
      "orgConfig.previewRollback",
      { orgId: w.orgId, toVersion: made.version },
      w.human,
    );
    expect(preview.currentVersion).toBe(made.version + 1);
    const other = await world();
    const refused = await call(
      "orgConfig.previewRollback",
      { orgId: w.orgId, toVersion: made.version },
      other.human,
    ).catch((e: { code: string }) => e);
    expect((refused as { code: string }).code).toBe("forbidden");
  });

  it("refuses an agent save drafted on an older version instead of replacing the newer one", async () => {
    const { w, made } = await orgWithWorkflow();
    const agent = { name: "Writer", role: "implement", tier: "standard", instructions: "" };
    await ok("agent.save", { orgId: w.orgId, baseVersion: made.version, agent }, w.human);
    const stale = await call(
      "agent.save",
      { orgId: w.orgId, baseVersion: made.version, agent: { ...agent, tier: "light" } },
      w.human,
    ).catch((e: { code: string }) => e);
    expect((stale as { code: string }).code).toBe("conflict");
  });
});

describe("a waiting rollback (review of #159, round 4)", () => {
  it("carries the org's config now and as the rollback would make it", async () => {
    const { w, got } = await orgWithWorkflow();
    // Tighten (more required checks), then roll back to before: that loosens, so it waits.
    const tighter = {
      ...got.workflow,
      stages: got.workflow.stages.map((s) =>
        s.type === "checks"
          ? {
              ...s,
              settings: { ...(s.settings as object), requiredChecks: ["ci", "typecheck", "e2e"] },
            }
          : s,
      ),
    };
    const saved = await ok<{ version: number }>(
      "workflow.save",
      { orgId: w.orgId, baseVersion: got.version, workflow: tighter },
      w.human,
    );
    const r = await call(
      "orgConfig.rollback",
      { orgId: w.orgId, baseVersion: saved.version, toVersion: got.version },
      w.human,
    );
    expect(r.status).toBe("pending");
    const org = await ok<Got>("orgConfig.get", { orgId: w.orgId }, w.human);
    const p = org.pending.find((x) => x.operation === "orgConfig.rollback");
    expect(p?.current?.workflows).toBeDefined();
    expect(p?.proposal?.workflows).toBeDefined();
    expect(p?.impact?.class).toBe("loosens");
  });
});
