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
/** The new core's tables (packages/store, ADR 0660) sit beside the platform's. */
const FLOW_TABLE_PREFIX = "flow_";

describe("core schema", () => {
  it("names every table and index core_* or flow_*", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger')",
    ).all<{ name: string; type: string }>();
    const offenders = results
      .filter(
        (r) =>
          !INTERNAL.test(r.name) &&
          !r.name.startsWith(CORE_TABLE_PREFIX) &&
          !r.name.startsWith(FLOW_TABLE_PREFIX),
      )
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

  it("refuses INSERT OR REPLACE over a row, by id or idempotency key (migration 0366)", async () => {
    const ins = (verb: string, id: string, actor: string, key: string | null) =>
      env.DB.prepare(
        `${verb} INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, input, idempotency_key)
         VALUES (?, '2026-01-01T00:00:00Z', 'runner.heartbeat', 'write', ?, 'x', '{}', 'allow', 'ok', '{}', ?)`,
      )
        .bind(id, actor, key)
        .run();
    await ins("INSERT", "au_person", "human", "key-1");
    await expect(ins("INSERT OR REPLACE", "au_person", "runner", null)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(ins("REPLACE", "au_other", "runner", "key-1")).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(ins("INSERT", "au_person", "runner", null)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    const row = await env.DB.prepare(
      "SELECT actor_type FROM core_audit WHERE id = 'au_person'",
    ).first();
    expect(row).toEqual({ actor_type: "human" });
  });

  it("is append-only with no exception once the archive is gone (migration 0438)", async () => {
    await env.DB.prepare(
      `INSERT INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, input)
       VALUES ('au_old', '2020-01-01T00:00:00Z', 'runner.heartbeat', 'write', 'runner', 'r', '{}', 'allow', 'ok', '{}')`,
    ).run();
    // A machine row years old was the archive's to delete; nothing deletes it now.
    await expect(
      env.DB.prepare("DELETE FROM core_audit WHERE id = 'au_old'").run(),
    ).rejects.toThrow(/append-only/);
  });

  it("keeps only the platform's core tables (migration 0438)", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 5) = 'core_' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "core_account",
      "core_audit",
      "core_batch_guard",
      "core_channel_requests",
      "core_cli_device_codes",
      "core_cli_tokens",
      "core_desktop_auth_requests",
      "core_desktop_devices",
      "core_github_connect_states",
      "core_github_installations",
      "core_invitation",
      "core_member",
      "core_meta",
      "core_mobile_nonces",
      "core_organization",
      "core_outbox",
      "core_pair_code_tries",
      "core_pair_offers",
      "core_presence_challenges",
      "core_runner_device_codes",
      "core_runner_shares",
      "core_runners",
      "core_session",
      "core_user",
      "core_verification",
    ]);
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
