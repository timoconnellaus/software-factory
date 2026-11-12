// The shadow reconciler's read side (spec 52 PR (c)): an item's report, and the org's agreement
// streak, which is no number while the comparison is incomplete. The engine writes the rows; here
// they are written directly.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SHADOW_NOT_COMPARED } from "../src/stages/index.ts";
import { newItem, ok, world } from "./helpers.ts";

async function verdict(item: string, org: string, finishedAt: string, divergences: number) {
  const report = {
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

  it("the streak says the comparison is incomplete, and what is missing, never a number", async () => {
    const w = await world();
    // Twenty items that agreed on everything compared: still no streak.
    for (let i = 0; i < 20; i++)
      await verdict(
        `wi_s${i}`,
        w.orgId,
        `2026-11-12T0${Math.floor(i / 10)}:${10 + (i % 10)}:00.000Z`,
        0,
      );
    const got = await ok<Record<string, unknown>>("reconcile.streak", { orgId: w.orgId }, w.human);
    expect(got.status).toBe("incomplete");
    expect(got).not.toHaveProperty("streak");
    expect(String(got.message)).toMatch(/^comparison incomplete: /);
    for (const aspect of [
      "jobs and attempts",
      "gates opened and decided, and by whom",
      "send-back targets and rounds",
      "retry counts",
      "slot steps",
    ])
      expect(got.missing).toContain(aspect);
  });
});
