import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation } from "../src/ops/define";
import { OperationError } from "../src/ops/errors";
import { invoke } from "../src/ops/invoke";
import { retryOutbox } from "../src/ops/outbox";
import { AGENT, call, HUMAN, rows, setPreset } from "./helpers";

// Test-only operations, so the pipeline is exercised without starting Workflows.
defineOperation({
  name: "test.note",
  description: "Store a note and announce it.",
  risk: "write",
  input: z.object({
    key: z.string(),
    value: z.string(),
    announceTo: z.string().optional(),
    notify: z.boolean().optional(),
  }),
  output: z.object({ stored: z.string() }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
        .bind(input.key, input.value),
    );
    if (input.announceTo) {
      // Sending to a Workflow instance that does not exist fails, so the row stays visible.
      ctx.emit({
        kind: "workflow.event",
        payload: { instanceId: input.announceTo, type: "noted", payload: { key: input.key } },
      });
    }
    if (input.notify) ctx.emit({ kind: "notify", payload: { event: "noted", key: input.key } });
    return { stored: input.key };
  },
});

defineOperation({
  name: "test.outbound",
  description: "Pretend to post a comment.",
  risk: "outbound",
  input: z.object({ text: z.string() }),
  output: z.object({ posted: z.boolean() }),
  async handler() {
    return { posted: true };
  },
});

const audits = (operation: string) =>
  rows<{
    outcome: string;
    decision: string;
    reason: string | null;
    actor_type: string;
    pending_action_id: string | null;
  }>(
    `SELECT outcome, decision, reason, actor_type, pending_action_id FROM audit WHERE operation = ? ORDER BY at, rowid`,
    operation,
  );

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM settings; DELETE FROM outbox; DELETE FROM pending_actions;`);
});

describe("invoke: the audit + outbox batch", () => {
  it("commits the write, its audit row and its outbox row together", async () => {
    const result = await call(
      "test.note",
      { key: "k1", value: "v", announceTo: "wi-missing" },
      HUMAN,
    );
    expect(result.status).toBe("ok");

    expect(await rows("SELECT value FROM settings WHERE key = 'k1'")).toEqual([{ value: "v" }]);
    const [audit] = await rows<{ id: string; outcome: string; result: string }>(
      `SELECT id, outcome, result FROM audit WHERE id = ?`,
      result.auditId,
    );
    expect(audit).toMatchObject({ outcome: "ok", result: JSON.stringify({ stored: "k1" }) });

    // Delivery failed (no such instance): the row stays, with the attempt recorded, for the cron.
    const [outbox] = await rows<{ kind: string; attempts: number; last_error: string }>(
      `SELECT kind, attempts, last_error FROM outbox`,
    );
    expect(outbox).toMatchObject({ kind: "workflow.event", attempts: 1 });
    expect(outbox?.last_error).toBeTruthy();
  });

  it("applies nothing when any statement in the batch fails: no write, no ok audit, no outbox", async () => {
    await call("test.note", { key: "dup", value: "first" }, HUMAN);
    await expect(
      call("test.note", { key: "dup", value: "second", announceTo: "x" }, HUMAN),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await rows("SELECT value FROM settings WHERE key = 'dup'")).toEqual([
      { value: "first" },
    ]);
    expect(await rows("SELECT id FROM outbox")).toEqual([]);
    const outcomes = (await audits("test.note")).map((a) => a.outcome);
    expect(outcomes.slice(-2)).toEqual(["ok", "failed"]);
  });

  it("delivers a successful outbox row and deletes it", async () => {
    // `notify` always delivers in the spike (it only logs).
    await call("test.note", { key: "k0", value: "v", notify: true }, HUMAN);
    expect(await rows("SELECT id FROM outbox")).toEqual([]);
  });

  it("retries outbox rows from the cron once they are due", async () => {
    await call("test.note", { key: "k2", value: "v", announceTo: "wi-missing" }, HUMAN);
    expect(await retryOutbox(env, new Date())).toBe(0); // within the grace period
    expect(await retryOutbox(env, new Date(Date.now() + 10 * 60_000))).toBe(1);
    expect(await rows<{ attempts: number }>("SELECT attempts FROM outbox")).toEqual([
      { attempts: 2 },
    ]);
  });

  it("keeps the audit journal append-only", async () => {
    await call("test.note", { key: "k3", value: "v" }, HUMAN);
    await expect(env.DB.exec("UPDATE audit SET outcome = 'denied'")).rejects.toThrow(/append-only/);
    await expect(env.DB.exec("DELETE FROM audit")).rejects.toThrow(/append-only/);
  });
});

describe("invoke: gate decisions", () => {
  it("rejects invalid input before the gate, without auditing", async () => {
    const before = (await audits("test.note")).length;
    await expect(call("test.note", { key: 1 }, HUMAN)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect((await audits("test.note")).length).toBe(before);
  });

  it("refuses an actor the operation does not allow, and audits it", async () => {
    await expect(call("policy.setPreset", { preset: "autonomous" }, AGENT)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await audits("policy.setPreset")).at(-1)).toMatchObject({
      outcome: "forbidden",
      actor_type: "agent",
    });
  });

  it("queues a review as a pending action with its audit and notify rows", async () => {
    await setPreset("balanced");
    const result = await call("test.outbound", { text: "hi" }, AGENT);
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(
      await rows(
        "SELECT operation, status FROM pending_actions WHERE id = ?",
        result.pendingActionId,
      ),
    ).toEqual([{ operation: "test.outbound", status: "pending" }]);
    expect((await audits("test.outbound")).at(-1)).toMatchObject({
      outcome: "review",
      pending_action_id: result.pendingActionId,
    });
  });

  it("lets the floor clamp a preset at runtime", async () => {
    await setPreset("autonomous");
    const ok = await call("test.outbound", { text: "a" }, AGENT);
    expect(ok.status).toBe("ok");

    const floored = { ...env, APPROVAL_FLOOR: JSON.stringify({ agent: { outbound: "review" } }) };
    const result = await invoke(
      floored,
      "test.outbound",
      { text: "b" },
      { actor: AGENT, origin: { surface: "test" } },
    );
    expect(result.status).toBe("pending");
    expect((await audits("test.outbound")).at(-1)).toMatchObject({
      outcome: "review",
      reason: "floor",
    });
  });

  it("fails closed on a malformed floor", async () => {
    const broken = { ...env, APPROVAL_FLOOR: "{not json" };
    await expect(
      invoke(
        broken,
        "test.note",
        { key: "k4", value: "v" },
        { actor: HUMAN, origin: { surface: "test" } },
      ),
    ).rejects.toMatchObject({ code: "denied" });
    expect(await rows("SELECT key FROM settings WHERE key = 'k4'")).toEqual([]);
  });

  it("refuses every non-human write while the kill switch is on, but not humans", async () => {
    await call("factory.setKillSwitch", { on: true }, HUMAN);
    await setPreset("autonomous");
    await expect(call("test.note", { key: "k5", value: "v" }, AGENT)).rejects.toMatchObject({
      code: "killed",
    });
    await expect(call("test.note", { key: "k6", value: "v" }, HUMAN)).resolves.toMatchObject({
      status: "ok",
    });
    await call("factory.setKillSwitch", { on: false }, HUMAN);
  });

  it("re-runs an approved action, and refuses an approval for a different operation", async () => {
    await setPreset("balanced");
    const pending = await call("test.outbound", { text: "c" }, AGENT);
    if (pending.status !== "pending") throw new Error("expected pending");

    await expect(
      call("test.note", { key: "k7", value: "v" }, AGENT, { approvalId: pending.pendingActionId }),
    ).rejects.toBeInstanceOf(OperationError);
    // Not decided yet.
    await expect(
      call("test.outbound", { text: "c" }, AGENT, { approvalId: pending.pendingActionId }),
    ).rejects.toMatchObject({
      code: "bad_approval",
    });

    await env.DB.prepare(`UPDATE pending_actions SET status = 'approved' WHERE id = ?`)
      .bind(pending.pendingActionId)
      .run();
    const applied = await call("test.outbound", { text: "c" }, AGENT, {
      approvalId: pending.pendingActionId,
    });
    expect(applied).toMatchObject({ status: "ok", output: { posted: true } });
    expect(
      await rows("SELECT status FROM pending_actions WHERE id = ?", pending.pendingActionId),
    ).toEqual([{ status: "applied" }]);
    // An approval is used once.
    await expect(
      call("test.outbound", { text: "c" }, AGENT, { approvalId: pending.pendingActionId }),
    ).rejects.toMatchObject({
      code: "bad_approval",
    });
  });

  it("returns the first outcome for a repeated idempotency key", async () => {
    const options = {
      actor: HUMAN,
      origin: { surface: "test" as const },
      idempotencyKey: "step-1",
    };
    const first = await invoke(env, "test.note", { key: "k8", value: "v" }, options);
    const second = await invoke(env, "test.note", { key: "k8", value: "v" }, options);
    expect(second).toEqual(first);
    expect(await rows("SELECT key FROM settings WHERE key = 'k8'")).toHaveLength(1);
  });
});
