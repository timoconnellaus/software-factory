// Parallel blocks land in any order (docs/parallel-work.md): D1 applies whatever migrations a
// database lacks, by name, so a block whose PR merges after higher-numbered ones from other blocks
// runs after them. This applies every other migration first, then each late block's, and checks
// the result is the same schema as applying them in order.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Blocks whose migrations may land after others' (block AQ, the Cloudflare cost work). */
const LATE_BLOCKS: [number, number][] = [[360, 369]];

const late = (name: string) => {
  const n = Number.parseInt(name, 10);
  return LATE_BLOCKS.some(([lo, hi]) => n >= lo && n <= hi);
};

async function schema(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY type, name",
    )
    .all<{ type: string; name: string; tbl_name: string }>();
  return results.map((r) => `${r.type} ${r.name} on ${r.tbl_name}`);
}

describe("migrations applied out of order", () => {
  it("each late block's migrations apply after all of the others, to the same schema", async () => {
    const others = env.TEST_MIGRATIONS.filter((m) => !late(m.name));
    const mine = env.TEST_MIGRATIONS.filter((m) => late(m.name));
    expect(mine.length).toBeGreaterThan(0);
    await applyD1Migrations(env.ORDER_DB, others);
    await applyD1Migrations(env.ORDER_DB, env.TEST_MIGRATIONS);
    expect(await schema(env.ORDER_DB)).toEqual(await schema(env.DB));
  });
});
