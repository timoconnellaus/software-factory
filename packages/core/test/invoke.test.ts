import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineOperation,
  getOperation,
  OPERATIONS,
  PERMISSIONS,
  RISK_CLASSES,
  runOperation,
} from "../src/index.ts";
import {
  call,
  connect,
  deps,
  first,
  ok,
  RUNNER_ACTOR,
  refusal,
  rows,
  uid,
  world,
} from "./helpers.ts";

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
      "org.list",
      "cli.deviceStart",
      "desktop.authStart",
      "presence.challenge",
      "mobile.authStart",
      "runner.register",
      "runner.heartbeat",
      "runner.claim",
      "github.connectInstallation",
    ]) {
      expect(names, verb).toContain(verb);
    }
    // The old pipeline's verbs are gone.
    for (const verb of ["workItem.create", "job.claim", "review.merge", "killSwitch.set"]) {
      expect(getOperation(verb), verb).toBeUndefined();
    }
  });
});

describe("invoke()", () => {
  it("writes the change and its audit row together", async () => {
    const w = await world();
    const { recordId } = await connect(w.human, w.orgId);
    const audit = await first<Record<string, string>>(
      "SELECT * FROM core_audit WHERE operation = 'github.connectInstallation' AND org_id = ? AND outcome = 'ok'",
      w.orgId,
    );
    expect(audit).toMatchObject({ actor_type: "human", actor_id: w.userId, decision: "allow" });
    expect(JSON.parse(audit.origin as string)).toEqual({ surface: "test" });
    expect(JSON.parse(audit.diff as string)[0]).toMatchObject({
      entity: "github_installation",
      id: recordId,
    });
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

  it("returns the first outcome for a repeated idempotency key", async () => {
    const w = await world();
    const key = uid("idem-");
    const once = await call("runner.register", { name: "Once" }, w.human, {
      idempotencyKey: key,
    });
    const again = await call("runner.register", { name: "Once" }, w.human, {
      idempotencyKey: key,
    });
    // The replay is the journaled outcome (its key redacted), not a second run.
    expect(again).toEqual({
      ...once,
      output: { ...(once.output as object), key: "[redacted]" },
    });
    expect(
      await rows("SELECT id FROM core_runners WHERE owner_user_id = ?", w.userId),
    ).toHaveLength(1);
  });

  it("refuses the wrong actor type, a non-member and a non-admin, and audits each", async () => {
    const w = await world();
    const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
    expect(
      (
        await refusal(
          call("github.connectStart", { orgId: w.orgId }, RUNNER_ACTOR(runner.runnerId)),
        )
      ).code,
    ).toBe("forbidden");
    const stranger = { type: "human" as const, id: uid("usr_") };
    expect((await refusal(call("github.connectStart", { orgId: w.orgId }, stranger))).code).toBe(
      "forbidden",
    );
    const audit = await rows<{ outcome: string }>(
      "SELECT outcome FROM core_audit WHERE org_id = ? AND outcome = 'forbidden'",
      w.orgId,
    );
    expect(audit).toHaveLength(2);
  });

  it("refuses a browser-only operation from the CLI", async () => {
    const w = await world();
    const refused = await refusal(
      runOperation(
        deps,
        getOperation("runner.register") as NonNullable<ReturnType<typeof getOperation>>,
        { name: "M5" },
        { actor: w.human, origin: { surface: "cli" } },
      ),
    );
    expect(refused.code).toBe("forbidden");
    expect(refused.details).toEqual({ browserOnly: true });
  });
});
