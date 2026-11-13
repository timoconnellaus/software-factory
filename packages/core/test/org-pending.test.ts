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
