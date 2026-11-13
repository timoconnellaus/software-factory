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
  it("a person's run now: a run that ends at once, saying why, hidden from the Work lists and the board", async () => {
    const w = await world();
    const id = await onAutopilot(w);
    const run = await ok<Run>("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human);
    expect(run).toMatchObject({ status: "failed", reason: NO_AUTOPILOT_RUNNER, duplicate: false });
    const item = await first<{ item_kind: string; status: string; autopilot_run_id: string }>(
      "SELECT item_kind, status, autopilot_run_id FROM core_work_items WHERE id = ?",
      run.workItemId,
    );
    expect(item).toEqual({ item_kind: "autopilot", status: "failed", autopilot_run_id: run.runId });
    // Its history on the autopilot's page.
    const got = await ok<{ runs: { id: string; status: string; trigger: string }[] }>(
      "autopilot.get",
      { orgId: w.orgId, autopilotId: id },
      w.human,
    );
    expect(got.runs).toEqual([expect.objectContaining({ id: run.runId, trigger: "manual" })]);
    // Not in the Work list or the board; found by number.
    const listed = await ok<{ items: { id: string }[] }>(
      "workItem.list",
      { projectId: w.projectId, limit: 50 },
      w.human,
    );
    expect(listed.items.map((i) => i.id)).not.toContain(run.workItemId);
    const board = await ok<{ items: { id: string }[]; counts: { status: string; n: number }[] }>(
      "workItem.board",
      { orgId: w.orgId, states: ["failed"] },
      w.human,
    );
    expect(board.items.map((i) => i.id)).not.toContain(run.workItemId);
    expect(board.counts.filter((c) => c.status === "failed")).toEqual([]);
  });

  it("an autopilot that is off doesn't run; its daily cap holds", async () => {
    const w = await world();
    const id = await onAutopilot(w, { minutes: 30, maxOutputs: 5, runsPerDay: 1 });
    await ok<Run>("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human);
    const second = await ok<Run>("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human);
    expect(second).toMatchObject({ status: "skipped", workItemId: null });
    expect(second.reason).toMatch(/daily cap/);
    await ok("autopilot.disable", { orgId: w.orgId, baseVersion: 3, autopilotId: id }, w.human);
    const off = await ok<Run>("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human);
    expect(off).toMatchObject({ status: "skipped", reason: "the autopilot is off" });
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

  it("a run doesn't take a slot under the project's active limit", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    const id = await onAutopilot(w);
    const run = await ok<Run>("autopilot.runNow", { orgId: w.orgId, autopilotId: id }, w.human);
    // Even were it running, it isn't counted: released work still starts in the one slot.
    await rows("UPDATE core_work_items SET status = 'running' WHERE id = ?", run.workItemId);
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
  });
});
