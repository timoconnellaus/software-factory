// Migration 0282 and spec 52 PR (d) leave every existing project exactly as it was (fourth review):
// a database built from main's migrations, holding a project with today's config (slot workflows,
// one of them named like an org workflow id, as nothing stopped before), then 0282. The project
// resolves to the very config it saved, runs the same plan, and saving it again is neutral.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { parseFloor, parseProjectPolicy, policyImpact, resolveScope } from "@software-factory/core";
import { compileProjectWorkflow, planFromDefinition } from "@software-factory/core/stages";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";

const TODAY = {
  version: 1,
  autonomyPolicy: "balanced",
  spec: { requiredFrom: "medium" },
  agents: [
    { name: "Security", role: "review", instructions: "Send back auth changes without tests." },
  ],
  workflows: [
    {
      name: "Ship a feature",
      slots: {
        beforeVerify: [
          { id: "security", kind: "work", name: "Security review", agent: "Security" },
        ],
        afterVerify: [{ id: "design", kind: "gate", name: "Design sign-off" }],
      },
    },
    // Named like an org workflow id: accepted before PR (d), so it must keep working.
    {
      name: "wf_legacy",
      slots: { afterVerify: [{ id: "sign-off", kind: "gate", name: "Sign-off" }] },
    },
  ],
  workflow: "wf_legacy",
};

describe("migration 0282", () => {
  it("leaves a project with today's config running exactly as before", async () => {
    const d1 = env.MIGRATION_DB;
    await applyD1Migrations(
      d1,
      env.TEST_MIGRATIONS.filter((m) => !m.name.startsWith("0282")),
    );
    const now = "2026-11-01T00:00:00.000Z";
    const raw = `${JSON.stringify(TODAY, null, 2)}\n`;
    await d1.batch([
      d1
        .prepare(
          "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES ('u1', 'Tim', 't@example.com', ?, ?)",
        )
        .bind(now, now),
      d1
        .prepare(
          "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES ('org1', 'Personal', 'org1', 'personal', ?)",
        )
        .bind(now),
      d1
        .prepare(
          "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'org1', 'u1', 'owner', ?)",
        )
        .bind(now),
      d1
        .prepare(
          "INSERT INTO core_factories (id, org_id, name, created_at, created_by) VALUES ('f1', 'org1', 'Factory', ?, 'u1')",
        )
        .bind(now),
      d1
        .prepare(
          "INSERT INTO core_projects (id, org_id, factory_id, name, slug, repo_owner, repo_name, policy_sha, created_at, created_by) VALUES ('p1', 'org1', 'f1', 'Site', 'site', 'o', 'site', 'v1', ?, 'u1')",
        )
        .bind(now),
      d1
        .prepare(
          "INSERT INTO core_project_policies (project_id, sha, ref, raw, valid, received_at, version, source, created_by) VALUES ('p1', 'v1', 'app', ?, 1, ?, 1, 'app', 'u1')",
        )
        .bind(raw, now),
    ]);
    await applyD1Migrations(d1, env.TEST_MIGRATIONS);

    const saved = parseProjectPolicy(raw);
    if (!saved.ok) throw new Error(saved.error);
    const scope = await resolveScope(createDb(d1), { projectId: "p1" });
    expect(scope.policyError).toBeNull();
    // The config the factory runs is the config as saved: no org workflow resolved into it.
    expect(scope.policy).toEqual(saved.policy);
    expect(scope.rawPolicy).toEqual(saved.policy);
    for (const size of ["small", "medium", "large"] as const)
      expect(
        planFromDefinition(
          compileProjectWorkflow(scope.policy ?? saved.policy, "wf_legacy"),
          saved.policy.agents,
          size,
          [],
          "wf_legacy",
        ).slots.afterVerify.map((s) => s.id),
      ).toEqual(["sign-off"]);
    // Saving it again unchanged is neutral, so it needs no approver.
    expect(policyImpact(saved.policy, saved.policy, parseFloor("")).class).toBe("neutral");
  });
});
