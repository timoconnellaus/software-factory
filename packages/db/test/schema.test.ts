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

  it("allows one version number per plan: core_specs' own UNIQUE, from migration 0020 (review of #85)", async () => {
    const { results } = await env.DB.prepare("PRAGMA index_list('core_specs')").all<{
      name: string;
      unique: number;
    }>();
    const unique = await Promise.all(
      results
        .filter((r) => r.unique === 1)
        .map(async (r) =>
          (
            await env.DB.prepare(`PRAGMA index_info('${r.name}')`).all<{ name: string }>()
          ).results.map((c) => c.name),
        ),
    );
    expect(unique).toContainEqual(["work_item_id", "version"]);
    // No migration rebuilt the table without it.
    const rebuilt = env.TEST_MIGRATIONS.filter((m) =>
      m.queries.some((q) => /CREATE TABLE core_specs\b|RENAME TO core_specs\b/i.test(q)),
    ).map((m) => m.name);
    expect(rebuilt).toEqual(["0020_work.sql"]);
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

  it("deletes only archived machine rows at least 90 days old (migration 0366)", async () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const day = old.slice(0, 10);
    const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const row = (
      id: string,
      at: string,
      over: {
        op?: string;
        actor?: string;
        actorId?: string;
        outcome?: string;
        decision?: string;
        pa?: string | null;
      } = {},
    ) =>
      env.DB.prepare(
        `INSERT INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, input, pending_action_id)
         VALUES (?, ?, ?, 'write', ?, ?, '{}', ?, ?, '{}', ?)`,
      )
        .bind(
          id,
          at,
          over.op ?? "runner.heartbeat",
          over.actor ?? "runner",
          over.actorId ?? "rnr_1",
          over.decision ?? "allow",
          over.outcome ?? "ok",
          over.pa ?? null,
        )
        .run();
    await row("au_m1", old);
    await row("au_m2", old, { op: "workItem.enterStage", actor: "agent", actorId: "foreman" });
    await row("au_h", old, { actor: "human", actorId: "usr_1" });
    await row("au_agent", old, { op: "workItem.enterStage", actor: "agent", actorId: "builder" });
    await row("au_merge", old, { op: "pr.merge", actor: "agent", actorId: "foreman" });
    await row("au_refused", old, { outcome: "fenced" });
    await row("au_gate", old, {
      op: "workItem.enterStage",
      actor: "agent",
      actorId: "foreman",
      decision: "review",
      outcome: "review",
      pa: "pa_1",
    });
    await row("au_late", old.replace(/T.*/, "T23:59:59.999Z"));
    await row("au_new", recent);
    // Nothing is covered yet: even a machine row is refused.
    await expect(env.DB.prepare("DELETE FROM core_audit WHERE id = 'au_m1'").run()).rejects.toThrow(
      /append-only/,
    );
    // A chunk covering every old row of the day except the last.
    await env.DB.prepare(
      `INSERT INTO core_audit_archive_chunks (day, seq, r2_key, first_at, first_id, last_at, last_id, rows, bytes, sha256, prev_hash, last_hash, archived_at)
       VALUES (?, 1, 'k', ?, 'au_', ?, 'au_z', 2, 1, 's', 'p', 'h', ?)`,
    )
      .bind(day, `${day}T00:00:00.000Z`, old, old)
      .run();
    await env.DB.prepare("DELETE FROM core_audit WHERE id IN ('au_m1', 'au_m2')").run();
    for (const id of [
      "au_h",
      "au_agent",
      "au_merge",
      "au_refused",
      "au_gate",
      "au_late",
      "au_new",
    ]) {
      await expect(
        env.DB.prepare("DELETE FROM core_audit WHERE id = ?").bind(id).run(),
        id,
      ).rejects.toThrow(/append-only/);
    }
    const left = await env.DB.prepare(
      "SELECT id FROM core_audit WHERE id IN ('au_m1', 'au_m2')",
    ).all();
    expect(left.results).toEqual([]);
    await expect(
      env.DB.prepare("UPDATE core_audit SET reason = 'x' WHERE id = 'au_h'").run(),
    ).rejects.toThrow(/append-only/);
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
