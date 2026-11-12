// The shadow reconciler's pass and pruning (spec 52 PR (c)): off the Workflow's path, it reads the
// items that ended since its cursor and writes one verdict row each; old verdicts go, a bounded batch
// at a time.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  pruneReconcileShadow,
  SHADOW_CURSOR,
  shadowPass,
  VERDICT_KEEP_MS,
} from "../src/reconcile-shadow.ts";
import { all, first, ok, world } from "./helpers.ts";

describe("the shadow reconciler", () => {
  it("writes nothing on the Workflow's path; the pass reads ended items after its cursor, one row each", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Shadowed" },
      w.human,
    );
    await ok("workItem.cancel", { workItemId: item.workItemId, reason: "test" }, w.human);
    // No outbox message and no shadow row from the operations themselves.
    expect(await all("SELECT id FROM core_outbox WHERE kind LIKE 'reconcile%'")).toEqual([]);
    expect(await first("SELECT work_item_id FROM core_reconcile_items")).toBeNull();
    while ((await shadowPass(env)) > 0);
    const cursor = await first<{ value: string }>(
      "SELECT value FROM core_meta WHERE key = ?",
      SHADOW_CURSOR,
    );
    expect(cursor?.value).toBeTruthy();
    // A second pass reads nothing new.
    expect(await shadowPass(env)).toBe(0);
  });

  it("deletes verdicts past 90 days, keeping newer ones", async () => {
    const now = new Date("2027-03-01T00:00:00.000Z");
    const old = new Date(now.getTime() - VERDICT_KEEP_MS - 1).toISOString();
    const fresh = new Date(now.getTime() - 1_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO core_reconcile_items (work_item_id, org_id, ended, transitions, divergences, report, finished_at) VALUES ('wi_old', 'org_p', 'done', 1, 6, '{}', ?), ('wi_new', 'org_p', 'done', 1, 6, '{}', ?)",
    )
      .bind(old, fresh)
      .run();
    await pruneReconcileShadow(env, now);
    expect(
      await first("SELECT work_item_id FROM core_reconcile_items WHERE work_item_id = 'wi_old'"),
    ).toBeNull();
    expect(
      await first("SELECT work_item_id FROM core_reconcile_items WHERE work_item_id = 'wi_new'"),
    ).not.toBeNull();
  });
});
