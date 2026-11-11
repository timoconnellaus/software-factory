import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { workItemIdFor } from "../src/ops/operations";
import { retryOutbox } from "../src/ops/outbox";
import { call, HUMAN, INTAKE, rows, setPreset } from "./helpers";

type Pending = { status: "pending"; pendingActionId: string };

let n = 0;
async function newWorkItem(size: "small" | "large") {
  const externalId = `issue-${Date.now()}-${n++}`;
  const id = await workItemIdFor("github", externalId);
  const instance = await introspectWorkflowInstance(env.WORK_ITEM_WORKFLOW, id);
  const intake = () =>
    call(
      "workItem.intake",
      { source: "github", externalId, title: `Fix ${externalId}`, size },
      INTAKE,
    );
  return { id, instance, intake };
}

const decide = (pendingActionId: string, decision: "approved" | "rejected") =>
  call("approval.decide", { pendingActionId, decision }, HUMAN);

const workItem = async (id: string) =>
  (
    await rows<{ stage: string; status: string }>(
      "SELECT stage, status FROM work_items WHERE id = ?",
      id,
    )
  )[0];

beforeEach(async () => {
  await env.DB.exec("DELETE FROM settings");
  await setPreset("balanced");
});

describe("work item Workflow", () => {
  it("pauses at the spec gate and the merge gate, and resumes on approval", async () => {
    const { id, instance, intake } = await newWorkItem("large");
    await using _ = instance;
    expect(await intake()).toMatchObject({
      status: "ok",
      output: { workItemId: id, duplicate: false },
    });

    const spec = (await instance.waitForStepResult({ name: "spec: request" })) as Pending;
    expect(spec.status).toBe("pending");
    // Paused: nothing past the gate happens. (Local Miniflare reports a waiting instance as
    // `running`, so the status alone cannot show it; see the README.)
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await (await env.WORK_ITEM_WORKFLOW.get(id)).status()).status).not.toBe("complete");
    expect(
      (
        await rows(
          "SELECT id FROM pending_actions WHERE status = 'pending' AND work_item_id = ?",
          id,
        )
      ).length,
    ).toBe(1);
    expect(await workItem(id)).toMatchObject({ stage: "triage", status: "running" });

    await decide(spec.pendingActionId, "approved");

    const merge = (await instance.waitForStepResult({ name: "merge: request" })) as Pending;
    expect(merge.status).toBe("pending");
    expect(await workItem(id)).toMatchObject({ stage: "verify", status: "running" });

    await decide(merge.pendingActionId, "approved");
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "done", workItemId: id });
    expect(await workItem(id)).toMatchObject({ stage: "merged", status: "done" });

    // The journal tells the whole story, in order: these rows are what metrics are computed from.
    const trail = await rows<{ operation: string; actor_type: string; outcome: string }>(
      "SELECT operation, actor_type, outcome FROM audit WHERE work_item_id = ? ORDER BY at, rowid",
      id,
    );
    expect(trail.map((r) => `${r.operation}:${r.actor_type}:${r.outcome}`)).toEqual([
      "workItem.intake:intake:ok",
      "workItem.triage:agent:ok",
      "spec.accept:agent:review",
      "approval.decide:human:ok",
      "spec.accept:agent:ok",
      "build.record:runner:ok",
      "verify.record:agent:ok",
      "pr.merge:agent:review",
      "approval.decide:human:ok",
      "pr.merge:agent:ok",
    ]);
  });

  it("starts one Workflow per intake event, however often it is delivered", async () => {
    const { id, instance, intake } = await newWorkItem("large");
    await using _ = instance;
    await intake();
    expect(await intake()).toMatchObject({
      status: "ok",
      output: { workItemId: id, duplicate: true },
    });
    await instance.waitForStepResult({ name: "spec: request" });
    expect(await rows("SELECT id FROM work_items WHERE id = ?", id)).toHaveLength(1);
    expect(await rows("SELECT id FROM pending_actions WHERE work_item_id = ?", id)).toHaveLength(1);

    // A redelivered start (the outbox retrying after a lost delete) finds the instance: delivered.
    await env.DB.prepare(
      `INSERT INTO outbox (id, at, kind, payload, next_at) VALUES ('ob_dup', ?, 'workflow.create', ?, ?)`,
    )
      .bind(
        new Date().toISOString(),
        JSON.stringify({ id, params: { workItemId: id } }),
        new Date().toISOString(),
      )
      .run();
    await retryOutbox(env, new Date(Date.now() + 1000));
    expect(await rows("SELECT id FROM outbox WHERE id = 'ob_dup'")).toEqual([]);
  });

  it("ends the work item when a gate is rejected", async () => {
    const { id, instance, intake } = await newWorkItem("large");
    await using _ = instance;
    await intake();
    const spec = (await instance.waitForStepResult({ name: "spec: request" })) as Pending;
    await decide(spec.pendingActionId, "rejected");
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ status: "rejected", workItemId: id });
    expect(await workItem(id)).toMatchObject({ status: "rejected" });
  });

  it("skips the spec gate for small work; merge still needs a human under Autonomous", async () => {
    await setPreset("autonomous");
    const { id, instance, intake } = await newWorkItem("small");
    await using _ = instance;
    await intake();
    const merge = (await instance.waitForStepResult({ name: "merge: request" })) as Pending;
    expect(merge.status).toBe("pending");
    await decide(merge.pendingActionId, "approved");
    await instance.waitForStatus("complete");
    expect(await workItem(id)).toMatchObject({ status: "done" });
    const ops = await rows<{ operation: string }>(
      "SELECT DISTINCT operation FROM audit WHERE work_item_id = ?",
      id,
    );
    expect(ops.map((o) => o.operation)).not.toContain("spec.accept");
  });

  it("keeps the spec gate for large work even under Autonomous", async () => {
    await setPreset("autonomous");
    const { instance, intake } = await newWorkItem("large");
    await using _ = instance;
    await intake();
    expect(await instance.waitForStepResult({ name: "spec: request" })).toMatchObject({
      status: "pending",
    });
  });

  it("expires the work item when nobody answers a gate", async () => {
    const { id, instance, intake } = await newWorkItem("small");
    await using _ = instance;
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: "merge: wait" });
    });
    await intake();
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ status: "expired" });
    expect(await workItem(id)).toMatchObject({ status: "expired" });
  });

  it("pauses running work items with the kill switch and resumes them when it is off", async () => {
    const { id, instance, intake } = await newWorkItem("large");
    await using _ = instance;
    await intake();
    const spec = (await instance.waitForStepResult({ name: "spec: request" })) as Pending;

    await call("factory.setKillSwitch", { on: true }, HUMAN);
    expect(await workItem(id)).toMatchObject({ status: "paused" });
    await instance.waitForStatus("paused");
    await expect(
      call("workItem.intake", { source: "github", externalId: "after-kill", title: "x" }, INTAKE),
    ).rejects.toMatchObject({ code: "killed" });

    // Approving while paused is allowed (humans aren't stopped); the event waits for the resume.
    await decide(spec.pendingActionId, "approved");
    await call("factory.setKillSwitch", { on: false }, HUMAN);
    expect(await workItem(id)).toMatchObject({ status: "running" });
    const merge = (await instance.waitForStepResult({ name: "merge: request" })) as Pending;
    expect(merge.status).toBe("pending");
  });

  it("parks a step the kill switch refused mid-flight, and runs it again once it is off", async () => {
    const { id, instance } = await newWorkItem("small");
    await using _ = instance;
    // Simulate the race: the work item exists and its Workflow starts after the switch went on.
    await env.DB.prepare(
      `INSERT INTO work_items (id, source, external_id, title, size, status, workflow_id, created_at, updated_at)
       VALUES (?, 'github', ?, 'Raced the kill switch', 'small', 'running', ?, ?, ?)`,
    )
      .bind(id, id, id, new Date().toISOString(), new Date().toISOString())
      .run();
    await call("factory.setKillSwitch", { on: true }, HUMAN);
    await env.WORK_ITEM_WORKFLOW.create({ id, params: { workItemId: id } });

    expect(await instance.waitForStepResult({ name: "triage: record" })).toMatchObject({
      status: "refused",
      code: "killed",
    });
    await call("factory.setKillSwitch", { on: false }, HUMAN);
    expect(await instance.waitForStepResult({ name: "triage: record #2" })).toMatchObject({
      status: "ok",
    });
    expect(await instance.waitForStepResult({ name: "merge: request" })).toMatchObject({
      status: "pending",
    });
  });
});
