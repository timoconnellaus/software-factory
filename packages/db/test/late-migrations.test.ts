// This branch's own migrations on a database that already has everything else (review of #85 /
// #90, spec 23): production has main's migrations applied when these land, so each must apply
// cleanly after all of them, and must not touch a table a higher-numbered migration rebuilt (a
// column added under such a rebuild is silently dropped on a fresh database).
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** The migrations this branch adds, by file name. Keep in step when one is added. */
const OWN = ["0373_planning_designs.sql", "0400_design_previews.sql"];

/** The columns they add, as `table.column`, which must exist both ways. */
const COLUMNS = [
  "core_planning_artifacts.design_type",
  "core_planning_artifacts.pulled_path",
  "core_planning_artifacts.pulled_base_sha",
  "core_specs.kim_files",
  "core_planning_artifact_revisions.preview",
];

async function columns(db: D1Database): Promise<Set<string>> {
  const tables = [...new Set(COLUMNS.map((c) => c.split(".")[0] as string))];
  const found = new Set<string>();
  for (const t of tables) {
    const { results } = await db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>();
    for (const r of results) found.add(`${t}.${r.name}`);
  }
  return found;
}

describe("this branch's migrations after everything else", () => {
  it("apply cleanly last, and add their columns", async () => {
    const all = env.TEST_MIGRATIONS;
    expect(OWN.every((name) => all.some((m) => m.name === name))).toBe(true);
    await applyD1Migrations(
      env.LATE_DB,
      all.filter((m) => !OWN.includes(m.name)),
    );
    await applyD1Migrations(
      env.LATE_DB,
      all.filter((m) => OWN.includes(m.name)),
    );
    const late = await columns(env.LATE_DB);
    for (const c of COLUMNS) expect(late.has(c)).toBe(true);
  });

  it("add their columns on a fresh database too (no later migration rebuilds those tables)", async () => {
    const fresh = await columns(env.DB);
    for (const c of COLUMNS) expect(fresh.has(c)).toBe(true);
  });
});
