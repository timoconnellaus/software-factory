// Migrations that move or drop data, run against a real D1 database that holds rows from before them.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const before = (n: number) => env.TEST_MIGRATIONS.filter((m) => Number.parseInt(m.name, 10) < n);
const db = env.UPGRADE_DB;
const NOW = "2026-11-15T00:00:00.000Z";

describe("migration 0438: the cutover drops the old pipeline's tables", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, before(438));
    await db.batch([
      db
        .prepare(
          "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES ('u1', 'Tim', 'u1@example.com', ?, ?)",
        )
        .bind(NOW, NOW),
      db
        .prepare(
          "INSERT INTO core_organization (id, name, slug, created_at) VALUES ('o1', 'Personal', 'o1', ?)",
        )
        .bind(NOW),
      db
        .prepare(
          "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'o1', 'u1', 'owner', ?)",
        )
        .bind(NOW),
      db
        .prepare(
          "INSERT INTO core_runners (id, owner_user_id, name, key_version, created_at) VALUES ('r_1', 'u1', 'M5', 1, ?)",
        )
        .bind(NOW),
      db
        .prepare(
          "INSERT INTO core_runner_shares (runner_id, scope, scope_id, created_at) VALUES ('r_1', 'org', 'o1', ?)",
        )
        .bind(NOW),
      db
        .prepare(
          "INSERT INTO core_github_installations (id, org_id, installation_id, account_login, account_type, status, repository_selection, connected_by, created_at, updated_at) VALUES ('ghi_1', 'o1', '42', 'acme', 'Organization', 'active', 'selected', 'u1', ?, ?)",
        )
        .bind(NOW, NOW),
      db
        .prepare(
          "INSERT INTO core_factories (id, org_id, name, created_at, created_by) VALUES ('fac_1', 'o1', 'Default', ?, 'u1')",
        )
        .bind(NOW),
      db
        .prepare(
          "INSERT INTO core_outbox (id, at, kind, payload, next_at) VALUES ('ob_1', ?, 'workflow.create', '{}', ?), ('ob_2', ?, 'notify', '{}', ?)",
        )
        .bind(NOW, NOW, NOW, NOW),
      db
        .prepare(
          `INSERT INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, input)
           VALUES ('au_1', ?, 'runner.register', 'write', 'human', 'u1', '{}', 'allow', 'ok', '{}')`,
        )
        .bind(NOW),
    ]);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
  });

  it("keeps the platform's rows: people, orgs, runners and their shares, installations, the journal", async () => {
    const count = async (table: string) =>
      (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n")) as number;
    for (const table of [
      "core_user",
      "core_organization",
      "core_member",
      "core_runners",
      "core_runner_shares",
      "core_github_installations",
      "core_audit",
    ]) {
      expect(await count(table), table).toBe(1);
    }
  });

  it("drops the old tables and the outbox rows nothing delivers any more", async () => {
    const gone = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('core_projects', 'core_factories', 'core_work_items', 'core_jobs', 'core_audit_archives')",
      )
      .all();
    expect(gone.results).toEqual([]);
    const outbox = await db.prepare("SELECT id FROM core_outbox ORDER BY id").all<{ id: string }>();
    expect(outbox.results.map((r) => r.id)).toEqual(["ob_2"]);
    expect(
      await db.prepare("SELECT value FROM core_meta WHERE key = 'schema_version'").first("value"),
    ).toBe("438");
  });
});
