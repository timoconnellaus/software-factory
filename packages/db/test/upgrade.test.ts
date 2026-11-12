// Migrations that move data, run against a real D1 database that holds rows from before them.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const before = (n: number) => env.TEST_MIGRATIONS.filter((m) => Number.parseInt(m.name, 10) < n);
const db = env.UPGRADE_DB;
const NOW = "2026-11-12T00:00:00.000Z";
const hex = (c: string) => c.repeat(32);

describe("migration 0210: a project is not a repository (ADR 0440)", () => {
  beforeAll(async () => {
    await applyD1Migrations(db, before(210));
    const P1 = `prj_${hex("a")}`;
    const P2 = `prj_${hex("b")}`;
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
          `INSERT INTO core_projects (id, org_id, factory_id, name, slug, repo_owner, repo_name, default_branch,
           github_installation_id, installation_record_id, github_repo_id, policy_pr_url, policy_sha, next_number, created_at, created_by)
         VALUES (?, 'o1', 'fac_1', 'Factory', 'factory', 'acme', 'factory', 'trunk', '42', 'ghi_1', 7, 'https://x/pr/1', 'v2', 4, ?, 'u1')`,
        )
        .bind(P1, NOW),
      db
        .prepare(
          `INSERT INTO core_projects (id, org_id, factory_id, name, slug, repo_owner, repo_name, created_at, created_by)
         VALUES (?, 'o1', 'fac_1', 'Site', 'site', 'acme', 'site', ?, 'u1')`,
        )
        .bind(P2, NOW),
      db
        .prepare(
          "INSERT INTO core_project_policies (project_id, sha, ref, raw, valid, received_at, version, source) VALUES (?, 'v2', 'app', '{}', 1, ?, 2, 'app')",
        )
        .bind(P1, NOW),
      db
        .prepare(
          "INSERT INTO core_project_protection (project_id, state, problems, warnings, trigger, checked_at, changed_at) VALUES (?, 'ok', '[]', '[]', 'daily', ?, ?)",
        )
        .bind(P1, NOW, NOW),
      db
        .prepare(
          "INSERT INTO core_config_trials (id, project_id, base_sha, candidate_sha, kind, summary, target_items, created_by, created_at) VALUES ('trl_1', ?, 'v1', 'v2', 'practice', 's', 3, 'u1', ?)",
        )
        .bind(P1, NOW),
      db
        .prepare(
          `INSERT INTO core_work_items (id, org_id, project_id, workflow_id, number, slug, title, requester_user_id, source, branch, created_at, updated_at)
         VALUES ('wi_1', 'o1', ?, 'wi_1', 3, 'x', 'Fix it', 'u1', 'app', 'factory/3-x', ?, ?)`,
        )
        .bind(P1, NOW, NOW),
      db
        .prepare(
          "INSERT INTO core_stages (id, work_item_id, stage, attempt, status, started_at) VALUES ('stg_1', 'wi_1', 'intake', 1, 'done', ?)",
        )
        .bind(NOW),
      db
        .prepare(
          "INSERT INTO core_merge_queue (id, project_id, work_item_id, approved_sha, head_sha, enqueued_at, updated_at) VALUES ('mq_1', ?, 'wi_1', 'abc', 'abc', ?, ?)",
        )
        .bind(P1, NOW, NOW),
      db
        .prepare(
          "INSERT INTO core_verify_checks (project_id, head_sha, work_item_id, status, title, updated_at) VALUES (?, 'abc', 'wi_1', 'queued', 't', ?)",
        )
        .bind(P1, NOW),
      db
        .prepare(
          "INSERT INTO core_attachments (id, work_item_id, org_id, project_id, filename, content_type, size_bytes, sha256, blob_key, uploader_type, uploader_id, created_at) VALUES ('att_1', 'wi_1', 'o1', ?, 'a.png', 'image/png', 1, 'x', 'k', 'human', 'u1', ?)",
        )
        .bind(P1, NOW),
    ]);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
  });

  it("gives each project exactly one repository with its repo fields", async () => {
    const { results } = await db
      .prepare("SELECT * FROM core_repositories ORDER BY name")
      .all<Record<string, unknown>>();
    expect(results).toEqual([
      expect.objectContaining({
        id: `repo_${hex("a")}`,
        org_id: "o1",
        project_id: `prj_${hex("a")}`,
        owner: "acme",
        name: "factory",
        default_branch: "trunk",
        github_installation_id: "42",
        installation_record_id: "ghi_1",
        github_repo_id: 7,
        policy_pr_url: "https://x/pr/1",
      }),
      expect.objectContaining({
        id: `repo_${hex("b")}`,
        project_id: `prj_${hex("b")}`,
        name: "site",
        default_branch: "main",
        github_installation_id: null,
      }),
    ]);
  });

  it("keeps project ids, numbers and config versions, without the repo columns", async () => {
    const project = await db
      .prepare("SELECT * FROM core_projects WHERE id = ?")
      .bind(`prj_${hex("a")}`)
      .first<Record<string, unknown>>();
    expect(project).toEqual({
      id: `prj_${hex("a")}`,
      org_id: "o1",
      factory_id: "fac_1",
      name: "Factory",
      slug: "factory",
      policy_sha: "v2",
      next_number: 4,
      created_at: NOW,
      created_by: "u1",
    });
  });

  it("keeps the rows that reference projects (no cascade on the rebuild)", async () => {
    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n;
    expect(await count("SELECT count(*) AS n FROM core_project_policies")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM core_project_protection")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM core_stages")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM core_config_trials")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM core_merge_queue")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM core_verify_checks")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM core_attachments")).toBe(1);
    expect(
      await count("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'core_0210_%'"),
    ).toBe(0);
    expect(await count("SELECT count(*) AS n FROM core_repositories")).toBe(2);
  });

  it("points every work item at its project's repository", async () => {
    const item = await db
      .prepare("SELECT project_id, repository_id FROM core_work_items WHERE id = 'wi_1'")
      .first();
    expect(item).toEqual({ project_id: `prj_${hex("a")}`, repository_id: `repo_${hex("a")}` });
  });

  it("enforces one project per GitHub repository and the projects foreign key", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO core_repositories (id, org_id, project_id, owner, name, created_at, created_by) VALUES ('repo_x', 'o1', ?, 'acme', 'factory', ?, 'u1')",
        )
        .bind(`prj_${hex("b")}`, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      db
        .prepare(
          "INSERT INTO core_repositories (id, org_id, project_id, owner, name, created_at, created_by) VALUES ('repo_y', 'o1', 'prj_nope', 'acme', 'other', ?, 'u1')",
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("migration 0211: backlog, ready, queued (ADR 0441)", () => {
  it("keeps every item, its merge-queue entry and attachments, and adds the new states", async () => {
    // UPGRADE_DB was migrated to the latest in the 0210 block above, with rows from before 0210.
    const item = await db
      .prepare(
        "SELECT status, priority, rank, repository_id, pulled_at FROM core_work_items WHERE id = 'wi_1'",
      )
      .first();
    expect(item).toEqual({
      status: "running",
      priority: 2,
      rank: 0,
      repository_id: `repo_${hex("a")}`,
      pulled_at: null,
    });
    expect(
      (await db.prepare("SELECT count(*) AS n FROM core_merge_queue").first<{ n: number }>())?.n,
    ).toBe(1);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM core_attachments").first<{ n: number }>())?.n,
    ).toBe(1);
    await db.prepare("UPDATE core_work_items SET status = 'backlog' WHERE id = 'wi_1'").run();
    await expect(
      db.prepare("UPDATE core_work_items SET status = 'someday' WHERE id = 'wi_1'").run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db
        .prepare(
          "INSERT INTO core_work_item_links (work_item_id, waits_for_id, created_at, created_by) VALUES ('wi_1', 'wi_1', ?, 'u1')",
        )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });
});
