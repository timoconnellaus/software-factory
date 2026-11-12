// The shadow reconciler's pass and pruning (spec 52 PR (c)): off the Workflow's path, it reads the
// items that ended since its cursor and writes one verdict row each; old verdicts go, a bounded batch
// at a time.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  pruneReconcileShadow,
  SHADOW_CURSOR,
  SHADOW_LAG_MS,
  shadowPass,
  VERDICT_KEEP_MS,
} from "../src/reconcile-shadow.ts";
import { all, first, ok, world } from "./helpers.ts";

const later = () => new Date(Date.now() + SHADOW_LAG_MS + 60_000);

/**
 * An item ended as `status` with the given stage history, written directly. Created in the Backlog,
 * so no Workflow starts and writes stages of its own.
 */
async function ended(w: Awaited<ReturnType<typeof world>>, status: string, stages: string[]) {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "backlog", projectId: w.projectId, title: "Shadowed" },
    w.human,
  );
  const id = item.workItemId;
  const t0 = Date.now();
  await env.DB.batch([
    ...stages.map((x, i) => {
      const [stage, st] = x.split(":");
      return env.DB.prepare(
        "INSERT INTO core_stages (id, work_item_id, stage, attempt, status, started_at) VALUES (?, ?, ?, 1, ?, ?)",
      ).bind(`st_${id}_${i}`, id, stage, st, new Date(t0 + i).toISOString());
    }),
    env.DB.prepare(
      "UPDATE core_work_items SET status = ?, size = 'small', spec_required = 0, pulled_at = ?, updated_at = ? WHERE id = ?",
    ).bind(status, new Date(t0).toISOString(), new Date(t0 + 100).toISOString(), id),
  ]);
  return id;
}

const SMALL_DONE = [
  "intake:done",
  "triage:done",
  "spec:skipped",
  "build:done",
  "verify:done",
  "merge:done",
  "done:done",
];

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
    // Within the lag the item waits: its write may not be the last one in flight.
    while ((await shadowPass(env, new Date())) > 0);
    const before = await first<{ value: string }>(
      "SELECT value FROM core_meta WHERE key = ?",
      SHADOW_CURSOR,
    );
    expect(before?.value ?? "").not.toContain(item.workItemId);
    while ((await shadowPass(env, later())) > 0);
    const cursor = await first<{ value: string }>(
      "SELECT value FROM core_meta WHERE key = ?",
      SHADOW_CURSOR,
    );
    expect(cursor?.value).toBeTruthy();
    // A second pass reads nothing new.
    expect(await shadowPass(env, later())).toBe(0);
  });

  it("pages by (updated_at, id): items that ended at the same instant are all read", async () => {
    const w = await world();
    while ((await shadowPass(env, later())) > 0);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await ended(w, "done", SMALL_DONE));
    const same = new Date(Date.now() + 5).toISOString();
    for (const id of ids)
      await env.DB.prepare("UPDATE core_work_items SET updated_at = ? WHERE id = ?")
        .bind(same, id)
        .run();
    let read = 0;
    for (let n = await shadowPass(env, later()); n > 0; n = await shadowPass(env, later()))
      read += n;
    expect(read).toBe(3);
    const rows = await all<{ work_item_id: string }>(
      `SELECT work_item_id FROM core_reconcile_items WHERE work_item_id IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    );
    expect(rows).toHaveLength(3);
  });

  it("names a head the merge queue moved, apart from other divergences (spec 53)", async () => {
    const w = await world();
    const moved = await ended(w, "done", SMALL_DONE);
    const still = await ended(w, "done", SMALL_DONE);
    await env.DB.prepare(
      "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, sections, created_at) VALUES ('rp_carried', ?, 'b2', 'pass', ?, ?)",
    )
      .bind(moved, JSON.stringify({ carriedFrom: "a1" }), new Date().toISOString())
      .run();
    while ((await shadowPass(env, later())) > 0);
    const report = async (id: string) =>
      ok<{ report: { known: { reason: string }[]; divergences: number } }>(
        "reconcile.report",
        { workItemId: id },
        w.human,
      );
    const a = await report(moved);
    const b = await report(still);
    expect(a.report.known.map((k) => k.reason)).toEqual(["queue-head-moved"]);
    expect(b.report.known).toEqual([]);
    expect(a.report.divergences).toBe(b.report.divergences + 1);
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
