// The pull from the outbox and the cron (ADR 0491): create-and-release starts through the outbox's
// `queue.pull`; the minute cron pulls a project where something can start, and skips one at its
// active limit or whose queued work waits on something undone.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pullQueuedWork } from "../src/pull.ts";
import { BALANCED, first, ok, world } from "./helpers.ts";

const statusOf = async (id: string) =>
  (await first<{ status: string }>("SELECT status FROM core_work_items WHERE id = ?", id))?.status;

describe("the pull in the engine", () => {
  it("starts create-and-release work through the outbox, and the cron catches the rest", async () => {
    const w = await world({ ...BALANCED, activeLimit: 1 });
    const one = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "First" },
      w.human,
    );
    expect(await statusOf(one.workItemId)).toBe("running");
    const two = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Second" },
      w.human,
    );
    expect(await statusOf(two.workItemId)).toBe("queued");
    // At the limit: the cron's query doesn't even ask.
    expect(await pullQueuedWork(env)).toBe(0);
    // Room again (the first ended without a pull being asked for): the cron starts the second.
    await env.DB.prepare("UPDATE core_work_items SET status = 'done' WHERE id = ?")
      .bind(one.workItemId)
      .run();
    expect(await pullQueuedWork(env)).toBeGreaterThanOrEqual(1);
    expect(await statusOf(two.workItemId)).toBe("running");
  });
});
