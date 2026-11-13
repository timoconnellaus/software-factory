// Migration 0390 rebuilds core_jobs for the last time (spec 53 part d, ADR 0620): no CHECK on the
// stage (it is validated in code), and every column and index it had, including the partial
// queue index job.claim reads.
import { env } from "cloudflare:workers";
import { JOB_STAGES } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";

describe("migration 0390", () => {
  it("leaves core_jobs with no stage CHECK and all four indexes", async () => {
    const table = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'core_jobs'",
    ).first<{ sql: string }>();
    expect(table?.sql).not.toMatch(/CHECK \(stage/);
    expect(table?.sql).toMatch(/shaping INTEGER NOT NULL DEFAULT 0/);
    const { results } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'core_jobs' AND sql IS NOT NULL ORDER BY name",
    ).all<{ name: string; sql: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "core_jobs_claim_idx",
      "core_jobs_item_idx",
      "core_jobs_queue_idx",
      "core_jobs_status_idx",
    ]);
    expect(results.find((r) => r.name === "core_jobs_queue_idx")?.sql).toMatch(
      /WHERE status = 'queued'/,
    );
    expect(JOB_STAGES).toContain("babysit");
  });
});
