// The shadow reconciler's read side (spec 52 PR (c)): an item's report, and the org's agreement
// streak, a number now that the comparison covers everything. The engine writes the rows; here
// they are written directly.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SHADOW_NOT_COMPARED } from "../src/stages/index.ts";
import { newItem, ok, world } from "./helpers.ts";

async function verdict(
  item: string,
  org: string,
  finishedAt: string,
  divergences: number,
  covers: string[] = [],
) {
  const report = {
    covers,
    transitions: [
      { observed: "enter triage", predicted: "enter triage", agrees: true },
      { observed: "enter build", predicted: "enter spec", agrees: false },
    ],
    uncompared: [...SHADOW_NOT_COMPARED],
    divergences,
  };
  await env.DB.prepare(
    "INSERT INTO core_reconcile_items (work_item_id, org_id, ended, transitions, divergences, report, finished_at) VALUES (?, ?, 'done', 2, ?, ?, ?)",
  )
    .bind(item, org, divergences, JSON.stringify(report), finishedAt)
    .run();
}

describe("the reconciler in shadow: report and streak", () => {
  it("reports an ended item's transitions, what wasn't compared, and its divergences", async () => {
    const w = await world();
    const item = await newItem(w);
    const none = await ok<{ report: unknown }>(
      "reconcile.report",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(none.report).toBeNull();
    await verdict(
      item.workItemId,
      w.orgId,
      "2026-11-12T01:00:00.000Z",
      1 + SHADOW_NOT_COMPARED.length,
    );
    const got = await ok<{
      report: { transitions: { agrees: boolean }[]; uncompared: string[]; divergences: number };
    }>("reconcile.report", { workItemId: item.workItemId }, w.human);
    expect(got.report.transitions.map((t) => t.agrees)).toEqual([true, false]);
    expect(got.report.uncompared).toEqual([...SHADOW_NOT_COMPARED]);
    expect(got.report.divergences).toBe(1 + SHADOW_NOT_COMPARED.length);
  });

  it("the streak counts ended items in a row with no divergence, newest first, now the comparison is complete", async () => {
    const w = await world();
    expect(SHADOW_NOT_COMPARED).toEqual([]);
    // One divergence, then twenty that agreed on everything.
    await verdict("wi_bad", w.orgId, "2026-11-12T00:00:00.000Z", 2);
    for (let i = 0; i < 20; i++)
      await verdict(
        `wi_s${i}`,
        w.orgId,
        `2026-11-12T0${1 + Math.floor(i / 10)}:${10 + (i % 10)}:00.000Z`,
        0,
        i === 3 ? ["a cancel", "an incident"] : [],
      );
    const got = await ok<Record<string, unknown>>("reconcile.streak", { orgId: w.orgId }, w.human);
    // Beside the number, the scenarios its items covered, and the ones none has yet.
    expect(got.coverage).toMatchObject({ covered: ["a cancel", "an incident"] });
    expect((got.coverage as { missing: string[] }).missing).toHaveLength(7);
    // Twenty in a row isn't enough on its own: coverage and the known gaps hold the switch-over.
    expect(got.switchOverReady).toBe(false);
    expect((got.knownGaps as string[]).length).toBeGreaterThan(0);
    expect(got).toMatchObject({
      status: "comparable",
      streak: 20,
      target: 20,
      ended: 21,
      lastDivergence: { workItemId: "wi_bad", divergences: 2 },
    });
    // A newer divergence resets it.
    await verdict("wi_newest", w.orgId, "2026-11-12T03:00:00.000Z", 1);
    const reset = await ok<Record<string, unknown>>(
      "reconcile.streak",
      { orgId: w.orgId },
      w.human,
    );
    expect(reset).toMatchObject({ status: "comparable", streak: 0 });
  });
});
