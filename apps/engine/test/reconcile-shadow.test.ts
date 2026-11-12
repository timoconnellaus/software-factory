// The shadow reconciler's pruning (spec 52 PR (c)): old rows go, a bounded batch at a time.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pruneReconcileShadow, SHADOW_KEEP_MS } from "../src/reconcile-shadow.ts";
import { first } from "./helpers.ts";

describe("pruning the shadow reconciler's rows", () => {
  it("deletes rows past 30 days and verdicts past 90, keeping newer ones", async () => {
    const now = new Date("2027-03-01T00:00:00.000Z");
    const old = new Date(now.getTime() - SHADOW_KEEP_MS - 1).toISOString();
    const fresh = new Date(now.getTime() - 1_000).toISOString();
    const ancient = new Date(now.getTime() - 100 * 24 * 3_600_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_reconcile_shadow (id, work_item_id, org_id, seq, observed, predicted, agrees, created_at) VALUES ('old', 'wi_p', 'org_p', 0, 'x', 'x', 1, ?), ('fresh', 'wi_p', 'org_p', 1, 'x', 'x', 1, ?)",
      ).bind(old, fresh),
      env.DB.prepare(
        "INSERT INTO core_reconcile_items (work_item_id, org_id, transitions, divergences, finished_at) VALUES ('wi_old', 'org_p', 1, 0, ?), ('wi_new', 'org_p', 1, 0, ?)",
      ).bind(ancient, old),
    ]);
    await pruneReconcileShadow(env, now);
    expect(await first("SELECT id FROM core_reconcile_shadow WHERE id = 'old'")).toBeNull();
    expect(await first("SELECT id FROM core_reconcile_shadow WHERE id = 'fresh'")).not.toBeNull();
    expect(
      await first("SELECT work_item_id FROM core_reconcile_items WHERE work_item_id = 'wi_old'"),
    ).toBeNull();
    expect(
      await first("SELECT work_item_id FROM core_reconcile_items WHERE work_item_id = 'wi_new'"),
    ).not.toBeNull();
  });
});
