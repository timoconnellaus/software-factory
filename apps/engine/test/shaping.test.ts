// Shaping stages run before release (spec 50 part C, ADR 0493): a shaped item's Workflow runs
// triage (and planning when the size needs it) while the item is unreleased and not active, waits
// at `release: wait`, and goes on to delivery when it is released and pulled.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pullQueuedWork } from "../src/pull.ts";
import {
  BALANCED,
  build,
  first,
  itemStatus,
  ok,
  runStage,
  triage,
  waitFor,
  world,
} from "./helpers.ts";

const statusOf = async (id: string) =>
  (await first<{ status: string }>("SELECT status FROM core_work_items WHERE id = ?", id))?.status;

describe("shaping before release (ADR 0493)", () => {
  it("shapes without a slot, waits ready, then delivers once released and there is room", async () => {
    const w = await world({ ...BALANCED, activeLimit: 1 });
    // One item already in delivery holds the only slot (no Workflow of its own, so no jobs).
    const busy = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Busy" },
      w.human,
    );
    await env.DB.prepare("UPDATE core_work_items SET status = 'running' WHERE id = ?")
      .bind(busy.workItemId)
      .run();

    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Shape me" },
      w.human,
    );
    const shaped = await ok<{ status: string }>(
      "workItem.shape",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(shaped.status).toBe("shaping");
    // Shaping runs although the project is at its active limit: it isn't delivery.
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await itemStatus(item.workItemId, "ready");
    const row = await first<{ stage: string; pulled_at: string | null }>(
      "SELECT stage, pulled_at FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row).toMatchObject({ pulled_at: null });

    // Released while the slot is taken: it waits, queued, with no build job.
    await ok("workItem.release", { workItemId: item.workItemId }, w.human);
    expect(await statusOf(item.workItemId)).toBe("queued");
    expect(
      await first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'",
        item.workItemId,
      ),
    ).toBeNull();

    // The slot frees: the pull wakes the shaped Workflow, which goes straight to build.
    await env.DB.prepare("UPDATE core_work_items SET status = 'done' WHERE id = ?")
      .bind(busy.workItemId)
      .run();
    await pullQueuedWork(env);
    await waitFor("the shaped item running", async () =>
      (await statusOf(item.workItemId)) === "running" ? true : null,
    );
    await runStage(w, item.workItemId, "build", () => build());
    // Triage ran once, before release.
    const triages = await first<{ n: number }>(
      "SELECT count(*) AS n FROM core_jobs WHERE work_item_id = ? AND stage = 'triage'",
      item.workItemId,
    );
    expect(triages?.n).toBe(1);
  });

  it("refuses shaping twice, and moving a shaped item back to the backlog", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Once" },
      w.human,
    );
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await itemStatus(item.workItemId, "ready");
    const again = await ok("workItem.shape", { workItemId: item.workItemId }, w.human).catch(
      (e: Error) => e,
    );
    expect(String(again)).toMatch(/already being shaped/);
    const back = await ok(
      "workItem.move",
      { workItemId: item.workItemId, to: "backlog" },
      w.human,
    ).catch((e: Error) => e);
    expect(String(back)).toMatch(/was shaped/);
  });
});
