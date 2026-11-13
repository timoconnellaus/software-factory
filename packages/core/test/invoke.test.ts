import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineOperation,
  FOREMAN,
  OPERATIONS,
  PERMISSIONS,
  RISK_CLASSES,
  runOperation,
} from "../src/index.ts";
import { setsPendingStatus } from "../src/invoke.ts";
import type { HandlerContext, PendingActionRow } from "../src/operation.ts";
import { decidePending } from "../src/operations/gates.ts";
import { call, deps, first, newItem, ok, refusal, rows, sha40, uid, world } from "./helpers.ts";

describe("the registry", () => {
  it("defines every operation once, each with a description, schemas, a permission, a risk class and actors", () => {
    const names = new Set<string>();
    for (const op of OPERATIONS) {
      expect(names.has(op.name), op.name).toBe(false);
      names.add(op.name);
      expect(op.description.length, op.name).toBeGreaterThan(30);
      expect(op.input, op.name).toBeInstanceOf(z.ZodType);
      expect(op.output, op.name).toBeInstanceOf(z.ZodType);
      expect(PERMISSIONS, op.name).toContain(op.permission);
      expect(RISK_CLASSES, op.name).toContain(op.risk);
      expect(op.actors.length, op.name).toBeGreaterThan(0);
    }
    for (const verb of [
      "workItem.create",
      "question.answer",
      "question.acceptDefaults",
      "spec.approve",
      "review.merge",
      "review.sendBack",
      "incident.open",
      "killSwitch.set",
      "job.claim",
      "run.handBack",
      "lease.claim",
    ]) {
      expect(names, verb).toContain(verb);
    }
  });
});

describe("a pending action's status (ADR 0541, third review of PR 1a)", () => {
  const pendingOp = (
    name: string,
    handler: (input: unknown, ctx: HandlerContext) => Promise<Record<string, unknown>>,
    decides = false,
  ) =>
    defineOperation({
      name,
      description: "A test operation that writes a pending action's status one way or another.",
      risk: "write",
      actors: ["human"],
      permission: "signed-in",
      ...(decides ? { decidesPending: true as const } : {}),
      input: z.object({}),
      output: z.object({}).passthrough(),
      handler,
    });
  const pa = {
    id: "pa_nothing",
    status: "pending",
    decision: null,
    operation: "pr.open",
    risk: "write",
    created_at: new Date().toISOString(),
    work_item_id: null,
    workflow_id: null,
  } as unknown as PendingActionRow;

  it("is written by decidePending only from an operation that declares decidesPending", async () => {
    const w = await world();
    const run = (op: ReturnType<typeof pendingOp>) =>
      runOperation(deps, op, {}, { actor: w.human, origin: { surface: "test" } });
    const undeclared = pendingOp("test.decidesUndeclared", async (_i, ctx) =>
      decidePending(ctx, pa, "approved", null),
    );
    await expect(run(undeclared)).rejects.toThrow(/doesn't declare decidesPending/);
    // Declared, it gets as far as the batch (the row isn't there, so its guard fails the batch).
    const declared = pendingOp(
      "test.decidesDeclared",
      async (_i, ctx) => decidePending(ctx, pa, "approved", null),
      true,
    );
    expect((await refusal(run(declared))).code).toBe("conflict");
    // Every operation that calls decidePending in core declares it (they run in the engine's tests).
    expect(
      OPERATIONS.filter((o) => o.decidesPending)
        .map((o) => o.name)
        .sort(),
    ).toEqual([
      "adjudicator.record",
      "approval.decide",
      "autoApprove.review",
      "review.merge",
      "review.sendBack",
      "spec.approve",
      "spec.requestChanges",
    ]);
  });

  it("can't be written with write(), by a query builder or by SQL", async () => {
    const w = await world();
    const run = (op: ReturnType<typeof pendingOp>) =>
      runOperation(deps, op, {}, { actor: w.human, origin: { surface: "test" } });
    const built = pendingOp("test.statusBuilt", async (_i, ctx) => {
      ctx.write(
        ctx.db
          .updateTable("core_pending_actions")
          .set({ status: "approved", decision: "approved" })
          .where("id", "=", "pa_nothing"),
      );
      return {};
    });
    await expect(run(built)).rejects.toThrow(/use writePendingStatus/);
    const raw = pendingOp("test.statusRaw", async (_i, ctx) => {
      ctx.write(
        ctx.d1
          .prepare("UPDATE core_pending_actions SET note = ?, status = 'rejected' WHERE id = ?")
          .bind("x", "pa_nothing"),
      );
      return {};
    });
    await expect(run(raw)).rejects.toThrow(/use writePendingStatus/);
    // Other columns are fine, a status in the WHERE clause too (gate.escalate).
    const other = pendingOp("test.statusWhere", async (_i, ctx) => {
      ctx.write(
        ctx.db
          .updateTable("core_pending_actions")
          .set({ note: "x" })
          .where("id", "=", "pa_nothing")
          .where("status", "=", "pending"),
      );
      return {};
    });
    expect((await run(other)).status).toBe("ok");
  });

  it("recognises a status write in SQL", () => {
    expect(setsPendingStatus('update "core_pending_actions" set "status" = ? where "id" = ?')).toBe(
      true,
    );
    expect(setsPendingStatus("UPDATE core_pending_actions SET note = ?,status='applied'")).toBe(
      true,
    );
    expect(setsPendingStatus("update or ignore core_pending_actions set status = ?")).toBe(true);
    expect(
      setsPendingStatus('update "core_pending_actions" set "note" = ? where "status" = ?'),
    ).toBe(false);
    expect(setsPendingStatus('update "core_pending_actions" set "status_note" = ?')).toBe(false);
    expect(setsPendingStatus('update "core_work_items" set "status" = ?')).toBe(false);
  });
});

describe("invoke()", () => {
  it("writes the change, its audit row and its outbox rows together", async () => {
    const w = await world();
    const item = await newItem(w);
    const audit = await first<Record<string, string>>(
      "SELECT * FROM core_audit WHERE operation = 'workItem.create' AND work_item_id = ?",
      item.workItemId,
    );
    expect(audit).toMatchObject({
      actor_type: "human",
      actor_id: w.userId,
      decision: "allow",
      outcome: "ok",
      policy_sha: w.policySha,
    });
    expect(JSON.parse(audit.origin as string)).toEqual({ surface: "test" });
    expect(JSON.parse(audit.diff as string)[0]).toMatchObject({
      entity: "work_item",
      id: item.workItemId,
    });
    const outbox = await rows<{ kind: string; payload: string }>(
      "SELECT kind, payload FROM core_outbox WHERE payload LIKE ?",
      `%${item.workItemId}%`,
    );
    expect(outbox.map((o) => o.kind)).toContain("workflow.create");
  });

  it("applies nothing when one write fails: no change, no outbox, a failed audit row", async () => {
    const w = await world();
    const op = defineOperation({
      name: "test.failingWrite",
      description: "A test operation whose second write violates a primary key.",
      risk: "write",
      actors: ["human"],
      permission: "signed-in",
      input: z.object({ key: z.string() }),
      output: z.object({}),
      async handler(input, ctx) {
        ctx.write(ctx.db.insertInto("core_meta").values({ key: input.key, value: "1" }));
        ctx.write(ctx.db.insertInto("core_meta").values({ key: input.key, value: "2" }));
        ctx.emit({ kind: "notify", payload: { event: "x", title: input.key } });
        return {};
      },
    });
    const key = uid("atomic-");
    const error = await refusal(
      runOperation(deps, op, { key }, { actor: w.human, origin: { surface: "test" } }),
    );
    expect(error.code).toBe("conflict");
    expect(await rows("SELECT * FROM core_meta WHERE key = ?", key)).toEqual([]);
    expect(await rows("SELECT * FROM core_outbox WHERE payload LIKE ?", `%${key}%`)).toEqual([]);
    const audit = await rows<{ outcome: string }>(
      "SELECT outcome FROM core_audit WHERE operation = 'test.failingWrite' AND input LIKE ?",
      `%${key}%`,
    );
    expect(audit.map((a) => a.outcome)).toEqual(["failed"]);
  });

  it("fails closed on a malformed policy, and audits the refusal with the policy SHA", async () => {
    const w = await world('{"version":1,"autonomyPolicy":"yolo"}');
    const project = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      w.projectId,
    );
    expect(project.policy_sha).toBe(w.policySha);
    // People can't create work on it either: agents couldn't run it.
    expect((await refusal(newItem(w))).code).toBe("unavailable");
    // An agent call on the project is denied and audited.
    const error = await refusal(call("workItem.list", { projectId: w.projectId }, FOREMAN));
    expect(error.code).toBe("denied");
    const audit = await first<{ outcome: string; reason: string; policy_sha: string }>(
      "SELECT outcome, reason, policy_sha FROM core_audit WHERE operation = 'workItem.list' AND project_id = ?",
      w.projectId,
    );
    expect(audit.outcome).toBe("denied");
    expect(audit.reason).toMatch(/no valid autonomy policy/);
    expect(audit.policy_sha).toBe(w.policySha);
  });

  it("denies everything under a malformed floor", async () => {
    const w = await world();
    const error = await refusal(
      call("workItem.create", { state: "queued", projectId: w.projectId, title: "x" }, w.human, {
        floor: "{bad",
      }),
    );
    expect(error.code).toBe("denied");
  });

  it("ignores a policy offered from any ref but the default branch", async () => {
    const w = await world();
    const result = await ok<{ applied: boolean }>(
      "policy.sync",
      {
        projectId: w.projectId,
        ref: "refs/heads/factory/1-loosen",
        sha: sha40("feed"),
        content: '{"version":1,"autonomyPolicy":"autonomous"}',
      },
      w.human,
    );
    expect(result.applied).toBe(false);
    const project = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      w.projectId,
    );
    expect(project.policy_sha).toBe(w.policySha);
  });

  it("returns the first outcome for a repeated idempotency key", async () => {
    const w = await world();
    const key = uid("idem-");
    const first_ = await call(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Once" },
      w.human,
      { idempotencyKey: key },
    );
    const again = await call(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Once" },
      w.human,
      { idempotencyKey: key },
    );
    expect(again).toEqual(first_);
    expect(
      await rows(
        "SELECT id FROM core_work_items WHERE project_id = ? AND title = 'Once'",
        w.projectId,
      ),
    ).toHaveLength(1);
  });

  it("refuses the wrong actor type and a non-member human, and audits both", async () => {
    const w = await world();
    expect(
      (
        await refusal(
          call("workItem.create", { state: "queued", projectId: w.projectId, title: "x" }, FOREMAN),
        )
      ).code,
    ).toBe("forbidden");
    const stranger = { type: "human" as const, id: uid("usr_") };
    expect(
      (
        await refusal(
          call(
            "workItem.create",
            { state: "queued", projectId: w.projectId, title: "x" },
            stranger,
          ),
        )
      ).code,
    ).toBe("forbidden");
    const audit = await rows<{ outcome: string }>(
      "SELECT outcome FROM core_audit WHERE project_id = ? AND outcome = 'forbidden'",
      w.projectId,
    );
    expect(audit).toHaveLength(2);
  });

  it("sends an agent's merge to review: a pending action, an audit row and a notification", async () => {
    const w = await world({
      version: 1,
      autonomyPolicy: "autonomous",
      overrides: { agent: { merge: "allow" } },
    });
    const item = await newItem(w);
    const result = await call(
      "pr.merge",
      { workItemId: item.workItemId, headSha: sha40("abc"), touchesFactoryConfig: false },
      FOREMAN,
    );
    expect(result.status).toBe("pending");
    const pa = await first<{ kind: string; risk: string; assignee_user_id: string }>(
      "SELECT kind, risk, assignee_user_id FROM core_pending_actions WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(pa).toMatchObject({ kind: "merge", risk: "merge", assignee_user_id: w.userId });
    const touches = await call(
      "pr.merge",
      { workItemId: item.workItemId, headSha: sha40("abc"), touchesFactoryConfig: true },
      FOREMAN,
    );
    expect(touches.status).toBe("pending");
    const risks = await rows<{ risk: string }>(
      "SELECT risk FROM core_pending_actions WHERE work_item_id = ? ORDER BY created_at",
      item.workItemId,
    );
    expect(risks.map((r) => r.risk)).toEqual(["merge", "self-modify"]);
    const status = await first<{ status: string }>(
      "SELECT status FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(status.status).toBe("waiting");
    void env;
  });
});

describe("kill switches", () => {
  it("refuse non-human writes on the switched project only, and people can still act", async () => {
    const a = await world();
    const b = await world();
    const itemA = await newItem(a);
    const itemB = await newItem(b);
    await ok(
      "killSwitch.set",
      { scope: "project", id: a.projectId, on: true, reason: "test" },
      a.human,
    );
    const killed = await refusal(
      call("workItem.enterStage", { workItemId: itemA.workItemId, stage: "triage" }, FOREMAN),
    );
    expect(killed.code).toBe("killed");
    expect(killed.details).toMatchObject({ scope: "project", scopeId: a.projectId, epoch: 1 });
    await ok("workItem.enterStage", { workItemId: itemB.workItemId, stage: "triage" }, FOREMAN);
    const paused = await first<{ status: string }>(
      "SELECT status FROM core_work_items WHERE id = ?",
      itemA.workItemId,
    );
    expect(paused.status).toBe("paused");
    const pauses = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'workflow.pause' AND payload LIKE ?",
      `%${itemA.workItemId}%`,
    );
    expect(pauses).toHaveLength(1);

    await ok("killSwitch.set", { scope: "project", id: a.projectId, on: false }, a.human);
    await ok("workItem.enterStage", { workItemId: itemA.workItemId, stage: "triage" }, FOREMAN);
    const resumes = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'workflow.resume' AND payload LIKE ?",
      `%${itemA.workItemId}%`,
    );
    expect(JSON.parse(resumes[0]?.payload ?? "{}").events).toContain(
      `resume-project-${a.projectId}-1`,
    );
  });

  it("the org switch covers every project in the org and needs an org admin", async () => {
    const w = await world();
    const item = await newItem(w);
    await ok("killSwitch.set", { scope: "org", id: w.orgId, on: true }, w.human);
    expect(
      (
        await refusal(
          call("workItem.enterStage", { workItemId: item.workItemId, stage: "triage" }, FOREMAN),
        )
      ).code,
    ).toBe("killed");
    const memberId = uid("usr_");
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'M', ?, ?, ?)",
      ).bind(memberId, `${memberId}@x`, now, now),
      env.DB.prepare(
        "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      ).bind(uid("mem_"), w.orgId, memberId, now),
    ]);
    const error = await refusal(
      call(
        "killSwitch.set",
        { scope: "org", id: w.orgId, on: false },
        { type: "human", id: memberId },
      ),
    );
    expect(error.code).toBe("forbidden");
  });
});

describe("leases and fencing tokens", () => {
  it("refuses a second claim on a held lease, lets an expired one be taken with a higher token, and refuses the old token", async () => {
    const w = await world();
    const item = await newItem(w);
    const one = await ok<{ fencingToken: number }>(
      "lease.claim",
      { workItemId: item.workItemId, holderId: "session-a", ttlSeconds: 60 },
      FOREMAN,
    );
    const held = await refusal(
      call("lease.claim", { workItemId: item.workItemId, holderId: "session-b" }, FOREMAN),
    );
    expect(held.code).toBe("conflict");

    await env.DB.prepare(
      "UPDATE core_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE work_item_id = ?",
    )
      .bind(item.workItemId)
      .run();
    const two = await ok<{ fencingToken: number }>(
      "lease.claim",
      { workItemId: item.workItemId, holderId: "session-b" },
      FOREMAN,
    );
    expect(two.fencingToken).toBeGreaterThan(one.fencingToken);

    const stale = await refusal(
      call(
        "lease.heartbeat",
        { workItemId: item.workItemId, fencingToken: one.fencingToken },
        FOREMAN,
      ),
    );
    expect(stale.code).toBe("fenced");
    const audit = await first<{ outcome: string }>(
      "SELECT outcome FROM core_audit WHERE operation = 'lease.heartbeat' AND work_item_id = ?",
      item.workItemId,
    );
    expect(audit.outcome).toBe("fenced");
    await ok(
      "lease.heartbeat",
      { workItemId: item.workItemId, fencingToken: two.fencingToken },
      FOREMAN,
    );
  });
});
