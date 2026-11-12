// Spec 09 M4: the adjudicator's minute, end to end with a workflow gate step (ADR 0374).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runAdjudicator } from "../src/index.ts";
import {
  BALANCED,
  build,
  first,
  gateOpen,
  ok,
  runStage,
  triage,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

const POLICY = {
  ...BALANCED,
  adjudicator: { step: "shadow" },
  workflow: "Signed off",
  workflows: [
    {
      name: "Signed off",
      slots: { beforeVerify: [{ id: "design", kind: "gate", name: "Design sign-off" }] },
    },
  ],
};

describe("the adjudicator's minute", () => {
  it("asks about an open gate step, records its shadow verdict, and leaves the gate to the person", async () => {
    const w = await world(POLICY);
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Add dark mode" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => build());
    const gate = await gateOpen(item.workItemId, "approval");

    await runAdjudicator(env);
    // Its read-only job, on the same item.
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.adjudicate).toMatchObject({ pendingActionId: gate.id, kind: "step" });
      expect(job.harness.prompt).toContain("Design sign-off");
      return { result: { verdict: "approve", reason: "Fine by the spec" } };
    });
    await runAdjudicator(env);
    const a = await waitFor("the verdict", () =>
      first<{ verdict: string; acted: number }>(
        "SELECT verdict, acted FROM core_adjudications WHERE pending_action_id = ? AND verdict IS NOT NULL",
        gate.id,
      ),
    );
    expect(a).toMatchObject({ verdict: "approve", acted: 0 });
    const pa = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      gate.id,
    );
    expect(pa?.status).toBe("pending");

    // The person decides; the item goes on to verify.
    await ok("approval.decide", { pendingActionId: gate.id, decision: "approved" }, w.human);
    await runStage(w, item.workItemId, "verify", (job) => {
      expect(job.context.adjudicate).toBeUndefined();
      return verifyPass;
    });
    await gateOpen(item.workItemId, "merge");
  });
});
