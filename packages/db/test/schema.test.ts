import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CORE_TABLE_PREFIX,
  clearGuards,
  createDb,
  failedGuard,
  guardChanged,
  guardExists,
  SCHEMA_VERSION,
  toStatement,
} from "../src/index.ts";

const INTERNAL = /^(sqlite_|_cf_|d1_)/;

describe("core schema", () => {
  it("names every table and index core_*", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger')",
    ).all<{ name: string; type: string }>();
    const offenders = results
      .filter((r) => !INTERNAL.test(r.name) && !r.name.startsWith(CORE_TABLE_PREFIX))
      .map((r) => `${r.type} ${r.name}`);
    expect(offenders).toEqual([]);
  });

  it("records the schema version, which equals the highest migration", async () => {
    const row = await env.DB.prepare(
      "SELECT value FROM core_meta WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    expect(Number(row?.value)).toBe(SCHEMA_VERSION);
    const highest = Math.max(...env.TEST_MIGRATIONS.map((m) => Number.parseInt(m.name, 10)));
    expect(highest).toBe(SCHEMA_VERSION);
  });

  it("keeps the audit journal append-only", async () => {
    await env.DB.prepare(
      `INSERT INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, input)
       VALUES ('au_1', '2026-11-11T00:00:00Z', 'x', 'read', 'human', 'u', '{}', 'allow', 'ok', '{}')`,
    ).run();
    await expect(env.DB.prepare("UPDATE core_audit SET reason = 'x'").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare("DELETE FROM core_audit").run()).rejects.toThrow(/append-only/);
  });
});

describe("batch guards", () => {
  const db = createDb(env.DB);
  const insertMeta = (key: string) =>
    toStatement(env.DB, db.insertInto("core_meta").values({ key, value: "v" }));

  it("abort the whole batch when a conditional write changed nothing", async () => {
    const batch = env.DB.batch([
      insertMeta("guard-a"),
      toStatement(
        env.DB,
        db.updateTable("core_meta").set({ value: "x" }).where("key", "=", "no-such-key"),
      ),
      guardChanged(env.DB, "update"),
      clearGuards(env.DB),
    ]);
    const error = await batch.catch((e: unknown) => e);
    expect(failedGuard(error)).toBe("guard");
    const row = await env.DB.prepare("SELECT key FROM core_meta WHERE key = 'guard-a'").first();
    expect(row).toBeNull();
  });

  it("let the batch commit when the condition holds, and leave no guard rows", async () => {
    await env.DB.batch([
      insertMeta("guard-b"),
      toStatement(
        env.DB,
        db.updateTable("core_meta").set({ value: "y" }).where("key", "=", "guard-b"),
      ),
      guardChanged(env.DB, "update"),
      guardExists(
        env.DB,
        "exists",
        db.selectFrom("core_meta").select("key").where("key", "=", "guard-b"),
      ),
      clearGuards(env.DB),
    ]);
    const row = await env.DB.prepare("SELECT value FROM core_meta WHERE key = 'guard-b'").first<{
      value: string;
    }>();
    expect(row?.value).toBe("y");
    const guards = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_batch_guard").first<{
      n: number;
    }>();
    expect(guards?.n).toBe(0);
  });

  it("abort when an EXISTS guard finds nothing", async () => {
    const error = await env.DB.batch([
      insertMeta("guard-c"),
      guardExists(
        env.DB,
        "exists",
        db.selectFrom("core_meta").select("key").where("key", "=", "missing"),
      ),
      clearGuards(env.DB),
    ]).catch((e: unknown) => e);
    expect(failedGuard(error)).toBe("guard");
    expect(
      await env.DB.prepare("SELECT key FROM core_meta WHERE key = 'guard-c'").first(),
    ).toBeNull();
  });
});
