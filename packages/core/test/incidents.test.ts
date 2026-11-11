import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { classifyIncident, FOREMAN } from "../src/index.ts";
import { first, newItem, ok, rows, world } from "./helpers.ts";

describe("incident root causes", () => {
  const c = (kind: "sent_back" | "run_failed" | "run_stalled" | "manual", reason: string) =>
    classifyIncident({ kind, reason, incidentId: "inc_x" }).rootCause;

  it("classifies from how it failed", () => {
    expect(c("run_failed", "Verify found problems:\n- failing: pnpm test")).toBe("missing-check");
    expect(c("run_failed", "Verify found problems:\n- unmet: The toggle persists")).toBe(
      "prompt-or-skill",
    );
    expect(c("run_stalled", "the run stalled")).toBe("runner");
    expect(c("run_failed", "lease expired: no heartbeat")).toBe("runner");
    expect(
      c(
        "run_failed",
        "gave up after 3 failed attempts: the build run failed: harness-config-mismatch: the process runs `claude --permission-mode auto`",
      ),
    ).toBe("runner");
    expect(
      c("run_failed", "branch confinement (ADR 0052): the run pushed outside its own branch"),
    ).toBe("confinement");
    expect(c("sent_back", "It didn't follow our convention for route files")).toBe(
      "missing-context",
    );
    expect(c("sent_back", "No tests for the new endpoint")).toBe("missing-check");
    expect(c("sent_back", "Not what I asked for")).toBe("prompt-or-skill");
    expect(c("manual", "hmm")).toBe("unknown");
  });

  it("proposes a .factory/ fix and names the regression case", () => {
    const fix = classifyIncident({
      kind: "run_failed",
      reason: "- failing: lint",
      incidentId: "inc_1",
    });
    expect(fix.proposedFix).toMatch(/\.factory\/checks\//);
    expect(fix.proposedFix).toMatch(/evals\/regressions\/inc_1\.json/);
  });
});

describe("opening incidents", () => {
  it("a send-back opens an incident in the same project with a root cause and a proposed fix", async () => {
    const w = await world();
    const item = await newItem(w);
    // Put a merge gate on the item, as the Workflow would.
    await env.DB.prepare(
      "UPDATE core_work_items SET head_sha = ?, pr_number = 1, stage = 'merge' WHERE id = ?",
    )
      .bind("a".repeat(40), item.workItemId)
      .run();
    const gate = await ok<unknown>(
      "pr.merge",
      { workItemId: item.workItemId, headSha: "a".repeat(40), touchesFactoryConfig: false },
      FOREMAN,
    ).catch(() => null);
    expect(gate).toBeNull(); // pending: the merge gate is open
    const out = await ok<{ incidentId: string }>(
      "review.sendBack",
      { workItemId: item.workItemId, note: "No tests for the toggle", openedFullDiff: true },
      w.human,
    );
    const incident = await first<{
      project_id: string;
      kind: string;
      root_cause: string;
      proposed_fix: string;
      fix_work_item_id: string;
    }>("SELECT * FROM core_incidents WHERE id = ?", out.incidentId);
    expect(incident).toMatchObject({
      project_id: w.projectId,
      kind: "sent_back",
      root_cause: "missing-check",
    });
    const fix = await first<{
      kind: string;
      project_id: string;
      body: string;
      parent_work_item_id: string;
    }>(
      "SELECT kind, project_id, body, parent_work_item_id FROM core_work_items WHERE id = ?",
      incident.fix_work_item_id,
    );
    expect(fix).toMatchObject({
      kind: "incident",
      project_id: w.projectId,
      parent_work_item_id: item.workItemId,
    });
    expect(fix.body).toContain(`evals/regressions/${out.incidentId}.json`);
    expect(fix.body).toContain("Root cause (first guess):** missing-check");
  });

  it("exhausted retries open one through incident.open; an incident's own failure opens none", async () => {
    const w = await world();
    const item = await newItem(w);
    const out = await ok<{ incidentId: string; fixWorkItemId: string; rootCause: string }>(
      "incident.open",
      {
        workItemId: item.workItemId,
        kind: "run_failed",
        reason: "gave up after 3 failed attempts: Verify found problems:\n- failing: typecheck",
      },
      FOREMAN,
    );
    expect(out.rootCause).toBe("missing-check");
    const nested = await ok<{ incidentId: string | null }>(
      "incident.open",
      { workItemId: out.fixWorkItemId, kind: "run_failed", reason: "again" },
      FOREMAN,
    );
    expect(nested.incidentId).toBeNull();
    expect(
      await rows("SELECT id FROM core_incidents WHERE source_work_item_id = ?", out.fixWorkItemId),
    ).toHaveLength(0);
  });
});
