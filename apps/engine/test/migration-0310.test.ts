// Migration 0310 rebuilds the device, token, challenge and sign-in tables (spec 60 PR 1a,
// criterion 6): every desktop row from before it survives, with its foreign keys, and still works.
// Run on an empty database: the migrations up to 0300, desktop rows, then 0310.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("migration 0310", () => {
  it("keeps the old desktop devices, tokens, challenges and sign-ins, and their links", async () => {
    const db = env.MIGRATION_DB;
    const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0310");
    const m0310 = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0310"));
    expect(m0310.length).toBe(1);
    await applyD1Migrations(db, before);
    const now = "2026-11-01T00:00:00.000Z";
    const later = "2026-12-01T00:00:00.000Z";
    await db.batch([
      db
        .prepare(
          "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES ('u1', 'Tim', 't@example.com', ?, ?)",
        )
        .bind(now, now),
      db
        .prepare(
          "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at, last_seen_at) VALUES ('dsk_1', 'u1', 'Mac', '{}', 'secure-enclave', ?, ?)",
        )
        .bind(now, now),
      db
        .prepare(
          "INSERT INTO core_cli_tokens (id, token_hash, user_id, name, scope, created_at, expires_at, kind, device_id) VALUES ('cli_1', 'h1', 'u1', 'Mac', 'write', ?, ?, 'desktop', 'dsk_1')",
        )
        .bind(now, later),
      db
        .prepare(
          "INSERT INTO core_cli_tokens (id, token_hash, user_id, name, scope, created_at, expires_at) VALUES ('cli_2', 'h2', 'u1', 'sf', 'read', ?, ?)",
        )
        .bind(now, later),
      db
        .prepare(
          "INSERT INTO core_presence_challenges (id, device_id, op, input_digest, summary, nonce_hash, created_at, expires_at) VALUES ('prc_1', 'dsk_1', 'spec.approve', 'd', 's', 'n', ?, ?)",
        )
        .bind(now, later),
      db
        .prepare(
          "INSERT INTO core_desktop_auth_requests (id, code_challenge, device_name, public_key, state, status, user_id, created_at, expires_at) VALUES ('dar_1', 'c', 'Mac', '{}', 's', 'approved', 'u1', ?, ?)",
        )
        .bind(now, later),
    ]);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(
      await db
        .prepare(
          "SELECT id, name, key_storage, platform, decides, attestation, last_seen_at FROM core_desktop_devices",
        )
        .all(),
    ).toMatchObject({
      results: [
        {
          id: "dsk_1",
          name: "Mac",
          key_storage: "secure-enclave",
          platform: "macos",
          decides: 1,
          attestation: null,
          last_seen_at: now,
        },
      ],
    });
    expect(
      (await db.prepare("SELECT id, kind, device_id, scope FROM core_cli_tokens ORDER BY id").all())
        .results,
    ).toEqual([
      { id: "cli_1", kind: "desktop", device_id: "dsk_1", scope: "write" },
      { id: "cli_2", kind: "cli", device_id: null, scope: "read" },
    ]);
    expect(
      (await db.prepare("SELECT id, device_id FROM core_presence_challenges").all()).results,
    ).toEqual([{ id: "prc_1", device_id: "dsk_1" }]);
    expect(
      (
        await db
          .prepare("SELECT id, status, platform, offer_id FROM core_desktop_auth_requests")
          .all()
      ).results,
    ).toEqual([{ id: "dar_1", status: "approved", platform: "macos", offer_id: null }]);
    const version = await db
      .prepare("SELECT value FROM core_meta WHERE key = 'schema_version'")
      .first<{ value: string }>();
    expect(Number(version?.value)).toBeGreaterThanOrEqual(310);

    // The rebuilt children point at the kept name, and the cascades still hold.
    const fks = await db
      .prepare("SELECT \"table\" FROM pragma_foreign_key_list('core_cli_tokens')")
      .all();
    expect(fks.results.map((r) => r.table).sort()).toEqual(["core_desktop_devices", "core_user"]);
    await db
      .prepare(
        "INSERT INTO core_cli_tokens (id, token_hash, user_id, scope, created_at, expires_at, kind, device_id) VALUES ('cli_3', 'h3', 'u1', 'write', ?, ?, 'mobile', 'dsk_1')",
      )
      .bind(now, later)
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO core_cli_tokens (id, token_hash, user_id, scope, created_at, expires_at, kind) VALUES ('cli_4', 'h4', 'u1', 'write', ?, ?, 'tablet')",
        )
        .bind(now, later)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await db.prepare("DELETE FROM core_desktop_devices WHERE id = 'dsk_1'").run();
    expect((await db.prepare("SELECT id FROM core_cli_tokens ORDER BY id").all()).results).toEqual([
      { id: "cli_2" },
    ]);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM core_presence_challenges").first())?.n,
    ).toBe(0);
  });
});
