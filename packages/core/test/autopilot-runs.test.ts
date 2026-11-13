// Autopilot runs (spec 52 build step (g2a), ADR 0514): a run is a work item whose kind is
// `autopilot` (item_kind, migration 0284), left out of the Work lists, the board and the active
// limit, shown in its autopilot's history. Until runners support autopilots (g2b) a run ends at
// once, saying so; nothing fires on its own yet (autopilot.fire has no caller).
import { describe, expect, it } from "vitest";
import { autopilotSchema } from "../src/autopilots/index.ts";
import { NO_AUTOPILOT_RUNNER } from "../src/operations/autopilots.ts";
import { call, first, ok, POLICY, refusal, rows, world } from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;
const SCHEDULER = { type: "scheduler" as const, id: "pull" };

async function onAutopilot(w: W, limits = { minutes: 30, maxOutputs: 5, runsPerDay: 4 }) {
  await ok(
    "agent.save",
    {
      orgId: w.orgId,
      baseVersion: 0,
      agent: { name: "Triager", role: "review", tier: "light", instructions: "" },
    },
    w.human,
  );
  const ap = autopilotSchema.parse({
    id: "ap_nightly",
    name: "Nightly triage",
    trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" },
    agent: "Triager",
    output: { kind: "labels" },
    limits,
  });
  await ok("autopilot.save", { orgId: w.orgId, baseVersion: 1, autopilot: ap }, w.human);
  const on = await call(
    "autopilot.enable",
    { orgId: w.orgId, baseVersion: 2, autopilotId: ap.id },
    w.human,
  );
  if (on.status === "pending")
    await ok(
      "approval.decide",
      { pendingActionId: on.pendingActionId, decision: "approved" },
      w.human,
    );
  return ap.id;
}

type Run = {
  runId: string;
  status: string;
  reason: string | null;
  workItemId: string | null;
  duplicate: boolean;
};

describe("autopilot runs (g2a)", () => {
  it("a person's run now: a run that ends at once, saying why, with no work item", async () => {
    const w = await world();
    const id = await onAutopilot(w);
    const run = await ok<Run>("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human);
    expect(run).toMatchObject({
      status: "failed",
      reason: NO_AUTOPILOT_RUNNER,
      workItemId: null,
      duplicate: false,
    });
    // Its history on the autopilot's page; nothing in the Work list or on the board.
    const got = await ok<{ runs: { id: string; status: string; trigger: string }[] }>(
      "autopilot.get",
      { orgId: w.orgId, autopilotId: id },
      w.human,
    );
    expect(got.runs).toEqual([expect.objectContaining({ id: run.runId, trigger: "manual" })]);
    expect(
      await rows("SELECT id FROM core_work_items WHERE autopilot_run_id = ?", run.runId),
    ).toEqual([]);
  });

  it("run now is refused, and writes nothing, while it's off or at its daily cap", async () => {
    const w = await world();
    const id = await onAutopilot(w, { minutes: 30, maxOutputs: 5, runsPerDay: 1 });
    await ok<Run>("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human);
    const capped = await refusal(
      call("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human),
    );
    expect(capped.message).toMatch(/daily cap/);
    await ok("autopilot.disable", { orgId: w.orgId, baseVersion: 3, autopilotId: id }, w.human);
    const off = await refusal(
      call("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human),
    );
    expect(off.message).toMatch(/off/);
    expect(await rows("SELECT id FROM core_autopilot_runs WHERE org_id = ?", w.orgId)).toHaveLength(
      1,
    );
  });

  it("skipped firings never fill the daily cap (counted in SQL)", async () => {
    const w = await world();
    const id = await onAutopilot(w, { minutes: 30, maxOutputs: 5, runsPerDay: 1 });
    const now = new Date().toISOString();
    for (let i = 0; i < 40; i++)
      await rows(
        `INSERT INTO core_autopilot_runs (id, org_id, autopilot_id, org_config_version, trigger, dedupe_key, status, reason, created_at)
         VALUES (?, ?, ?, 3, 'schedule', ?, 'skipped', 'x', ?)`,
        `apr_s${i}`,
        w.orgId,
        id,
        `old:${i}`,
        now,
      );
    const fired = await ok<Run>(
      "autopilot.fire",
      {
        orgId: w.orgId,
        autopilotId: id,
        trigger: "schedule",
        dedupeKey: "k1",
        requesterUserId: w.userId,
      },
      SCHEDULER,
    );
    expect(fired.status).toBe("failed");
    const again = await ok<Run>(
      "autopilot.fire",
      {
        orgId: w.orgId,
        autopilotId: id,
        trigger: "schedule",
        dedupeKey: "k2",
        requesterUserId: w.userId,
      },
      SCHEDULER,
    );
    expect(again).toMatchObject({ status: "skipped" });
    expect(again.reason).toMatch(/daily cap/);
  });

  it("never writes into another org: run now and fire refuse a project that isn't the org's", async () => {
    const a = await world();
    const id = await onAutopilot(a);
    const b = await world();
    // A member of B names A's autopilot and B's project: refused by A's member check.
    expect(
      (
        await refusal(
          call(
            "autopilot.runNow",
            { orgId: a.orgId, autopilotId: id, projectId: b.projectId },
            b.human,
          ),
        )
      ).code,
    ).toBe("forbidden");
    // A's own person naming B's project: refused, nothing written.
    expect(
      (
        await refusal(
          call(
            "autopilot.runNow",
            { orgId: a.orgId, autopilotId: id, projectId: b.projectId },
            a.human,
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await refusal(
          call(
            "autopilot.fire",
            {
              orgId: a.orgId,
              autopilotId: id,
              trigger: "event",
              dedupeKey: "x",
              projectId: b.projectId,
              requesterUserId: a.userId,
            },
            SCHEDULER,
          ),
        )
      ).code,
    ).toBe("invalid_input");
    expect(await rows("SELECT id FROM core_autopilot_runs WHERE org_id = ?", a.orgId)).toEqual([]);
  });

  it("a kill switch on the org or the project stops a run, a person's too", async () => {
    const w = await world();
    const id = await onAutopilot(w);
    await ok(
      "killSwitch.set",
      { scope: "project", id: w.projectId, on: true, reason: "stop" },
      w.human,
    );
    const r = await refusal(call("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human));
    expect(r.message).toMatch(/kill switch/);
  });

  it("one occurrence fires once; only the factory's scheduler fires", async () => {
    const w = await world();
    const id = await onAutopilot(w);
    const input = {
      orgId: w.orgId,
      autopilotId: id,
      trigger: "schedule",
      dedupeKey: `schedule:${id}:2026-11-14T02:00`,
      requesterUserId: w.userId,
    };
    const a = await ok<Run>("autopilot.fire", input, SCHEDULER);
    const b = await ok<Run>("autopilot.fire", input, SCHEDULER);
    expect(b).toMatchObject({ runId: a.runId, duplicate: true });
    expect(await rows("SELECT id FROM core_autopilot_runs WHERE org_id = ?", w.orgId)).toHaveLength(
      1,
    );
    expect((await refusal(call("autopilot.fire", input, w.human))).code).toBe("forbidden");
  });

  it("a run's item never takes the active limit's slot, nor shows in the Work list or the board", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    // A run item, as g2b's runs will have (marked by its run id): running.
    const made = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "backlog", projectId: w.projectId, title: "A run's item" },
      w.human,
    );
    await rows(
      "UPDATE core_work_items SET autopilot_run_id = 'apr_x', status = 'running' WHERE id = ?",
      made.workItemId,
    );
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Real work" },
      w.human,
    );
    const row = await first<{ status: string }>(
      "SELECT status FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row?.status).toBe("running");
    const listed = await ok<{ items: { id: string }[] }>(
      "workItem.list",
      { projectId: w.projectId, limit: 50 },
      w.human,
    );
    expect(listed.items.map((i) => i.id)).not.toContain(made.workItemId);
    const board = await ok<{ items: { id: string }[] }>(
      "workItem.board",
      { orgId: w.orgId, states: ["running"] },
      w.human,
    );
    expect(board.items.map((i) => i.id)).not.toContain(made.workItemId);
  });
});
