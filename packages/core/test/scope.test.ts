// resolveScope's one-round-trip batch (invoke's path) must give the same answers and the same
// refusals as the step-by-step lookups.
import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import { resolveScope } from "../src/scope.ts";
import { newItem, ok, refusal, sha40, uid, world } from "./helpers.ts";

const db = createDb(env.DB);

async function both(ref: Parameters<typeof resolveScope>[1], userId: string | null) {
  const plain = await resolveScope(db, ref);
  const { role, ...batched } = await resolveScope(db, ref, { d1: env.DB, userId });
  expect(batched).toEqual(plain);
  return { scope: plain, role };
}

describe("resolving a scope in one batch", () => {
  it("matches the step-by-step lookups for a work item, a project and an org, with the caller's role", async () => {
    const w = await world();
    const { workItemId } = await newItem(w);
    const byItem = await both({ workItemId, projectId: "ignored-when-there-is-an-item" }, w.userId);
    expect(byItem.scope).toMatchObject({ workItemId, projectId: w.projectId, orgId: w.orgId });
    expect(byItem.scope.policy?.autonomyPolicy).toBe("balanced");
    expect(byItem.role).toBe("owner");

    const byProject = await both({ projectId: w.projectId }, w.userId);
    expect(byProject.scope.policySha).toBe(w.policySha);
    expect(byProject.role).toBe("owner");

    expect((await both({ orgId: w.orgId }, w.userId)).role).toBe("owner");
    expect((await both({ orgId: w.orgId }, uid("usr_"))).role).toBeNull();
    expect((await both({ orgId: w.orgId }, null)).role).toBeUndefined();
    expect((await both({}, w.userId)).role).toBeUndefined();
  });

  it("fails closed the same way: no policy synced, a policy that isn't stored, a malformed one", async () => {
    const none = await world(null);
    const a = await both({ projectId: none.projectId }, none.userId);
    expect(a.scope.policy).toBeNull();
    expect(a.scope.policyError).toMatch(/no .factory\/policy.json/);

    const bad = await world("{ not json");
    const b = await both({ projectId: bad.projectId }, bad.userId);
    expect(b.scope.policy).toBeNull();
    expect(b.scope.policyError).toBeTruthy();

    const gone = await world();
    await env.DB.prepare("UPDATE core_projects SET policy_sha = ? WHERE id = ?")
      .bind(sha40("missing"), gone.projectId)
      .run();
    const c = await both({ projectId: gone.projectId }, gone.userId);
    expect(c.scope.policyError).toMatch(/not found/);
  });

  it("refuses an unknown work item or project with not_found", async () => {
    for (const ref of [{ workItemId: "wi_none" }, { projectId: "prj_none" }]) {
      const plain = await refusal(resolveScope(db, ref));
      const batched = await refusal(resolveScope(db, ref, { d1: env.DB, userId: null }));
      expect(batched.code).toBe("not_found");
      expect(batched.message).toBe(plain.message);
    }
  });

  it("still refuses a non-member through invoke", async () => {
    const w = await world();
    const { workItemId } = await newItem(w);
    const stranger = { type: "human" as const, id: uid("usr_") };
    const error = await refusal(ok("workItem.get", { workItemId }, stranger));
    expect(error.code).toBe("forbidden");
  });
});
