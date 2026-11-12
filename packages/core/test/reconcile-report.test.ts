// The shadow reconciler's read side (spec 52 PR (c)): an item's report, and the org's agreement
// streak that the switch-over waits for. The engine writes the rows; here they are written directly.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newItem, ok, world } from "./helpers.ts";

async function shadowRow(item: string, org: string, at: string, seq: number, agrees: boolean) {
  await env.DB.prepare(
    "INSERT INTO core_reconcile_shadow (id, work_item_id, org_id, seq, observed, predicted, agrees, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `${item}:${at}:${seq}`,
      item,
      org,
      seq,
      "enter build",
      agrees ? "enter build" : "enter spec",
      agrees ? 1 : 0,
      at,
    )
    .run();
}

async function verdict(item: string, org: string, finishedAt: string, divergences: number) {
  await env.DB.prepare(
    "INSERT INTO core_reconcile_items (work_item_id, org_id, transitions, divergences, finished_at) VALUES (?, ?, 6, ?, ?)",
  )
    .bind(item, org, divergences, finishedAt)
    .run();
}

describe("the reconciler in shadow: report and streak", () => {
  it("reports an item's transitions in order, with its divergences", async () => {
    const w = await world();
    const item = await newItem(w);
    await shadowRow(item.workItemId, w.orgId, "2026-11-12T01:00:00.000Z", 1, false);
    await shadowRow(item.workItemId, w.orgId, "2026-11-12T01:00:00.000Z", 0, true);
    const report = await ok<{
      transitions: { predicted: string; agrees: boolean }[];
      divergences: number;
    }>("reconcile.report", { workItemId: item.workItemId }, w.human);
    expect(report.transitions.map((t) => t.agrees)).toEqual([true, false]);
    expect(report.divergences).toBe(1);
  });

  it("the streak counts finished items back to the last divergence, which resets it", async () => {
    const w = await world();
    const streak = () =>
      ok<{ streak: number; target: number; lastDivergence: { workItemId: string } | null }>(
        "reconcile.streak",
        { orgId: w.orgId },
        w.human,
      );
    expect(await streak()).toMatchObject({ streak: 0, target: 20, lastDivergence: null });
    await verdict("wi_a", w.orgId, "2026-11-12T01:00:00.000Z", 0);
    await verdict("wi_b", w.orgId, "2026-11-12T02:00:00.000Z", 2);
    await verdict("wi_c", w.orgId, "2026-11-12T03:00:00.000Z", 0);
    await verdict("wi_d", w.orgId, "2026-11-12T04:00:00.000Z", 0);
    expect(await streak()).toMatchObject({ streak: 2, lastDivergence: { workItemId: "wi_b" } });
    await verdict("wi_e", w.orgId, "2026-11-12T05:00:00.000Z", 1);
    expect(await streak()).toMatchObject({ streak: 0, lastDivergence: { workItemId: "wi_e" } });
  });
});
