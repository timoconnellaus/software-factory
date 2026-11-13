// Spec 52 PR (d), migration: `orgConfig.adoptProjectWorkflows` changes nothing an item does, as a
// property (sixth review). For generated sets of projects in one org (identical workflows, differing
// ones, none, their own agents under one name with different instructions, their own builder or
// none), every project's resolved config, the plan the engine's own `planWorkflow` makes for every
// size and domain set, the agents each step and the build run with, and the checks an item runs are
// the same before the run and after it. The one thing allowed to differ is a name: the plan's (the
// workflow's id after, its name before) and an agent's where the org already had a different agent
// under that name (it gets the project's slug); what the agent is (role, tier, instructions,
// requirements) must not.
import { env } from "cloudflare:workers";
import { declaredChecks, resolveScope } from "@software-factory/core";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import { planWorkflow } from "../src/workflow/work-item.ts";
import { BALANCED, first, ok, uid, world } from "./helpers.ts";

/** A small seeded generator, so a failure names the seed that made it. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECURITY_SAYS = ["Send back auth changes without tests.", "Be strict about everything."];
const BUILDER_SAYS = ["Build it the way project A does.", "Small commits, tests first."];
const SIZES = ["small", "medium", "large"] as const;

function generate(seed: number): Record<string, unknown>[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const count = 2 + Math.floor(r() * 4);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const agents: Record<string, unknown>[] = [];
    // Its own builder, or none (then it builds with no agent of its own).
    if (r() < 0.5)
      agents.push({ name: "Builder", role: "implement", instructions: pick(BUILDER_SAYS) });
    const shape = pick(["none", "feature", "feature", "gate-only"] as const);
    let workflows: unknown[] = [];
    let workflow: string | undefined;
    if (shape !== "none") {
      agents.push({ name: "Security", role: "review", instructions: pick(SECURITY_SAYS) });
      const security = { id: "security", kind: "work", name: "Security review", agent: "Security" };
      const gate = { id: "design", kind: "gate", name: "Design sign-off" };
      workflows = [
        {
          name: "Ship a feature",
          slots:
            shape === "feature"
              ? { beforeVerify: [security], afterVerify: [gate] }
              : { afterVerify: [gate] },
        },
      ];
      workflow = "Ship a feature";
    }
    out.push({
      ...BALANCED,
      spec: { requiredFrom: pick(["small", "medium", "large"]) },
      retryLimit: pick([1, 2, 4]),
      protection: { requiredChecks: pick([["ci"], ["ci", "e2e"], []]) },
      ...(r() < 0.3 ? { checks: [{ name: "lint", run: "pnpm lint" }] } : {}),
      agents,
      workflows,
      ...(workflow ? { workflow } : {}),
    });
  }
  return out;
}

async function addProject(w: Awaited<ReturnType<typeof world>>, i: number, policy: unknown) {
  const id = uid("prj_");
  const now = new Date().toISOString();
  const base = await first<{ factory_id: string }>(
    "SELECT factory_id FROM core_projects WHERE id = ?",
    w.projectId,
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_projects (id, org_id, factory_id, name, slug, repo_owner, repo_name, policy_sha, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'o', ?, 'v1', ?, ?)",
    ).bind(id, w.orgId, base?.factory_id, `Project ${i}`, `project-${i}`, id, now, w.userId),
    env.DB.prepare(
      "INSERT INTO core_project_policies (project_id, sha, ref, raw, valid, received_at, version, source, created_by) VALUES (?, 'v1', 'app', ?, 1, ?, 1, 'app', ?)",
    ).bind(id, `${JSON.stringify(policy, null, 2)}\n`, now, w.userId),
  ]);
  return id;
}

/** Everything an item on the project would run with, less the names allowed to change. */
async function behaviour(projectId: string) {
  const scope = await resolveScope(createDb(env.DB), { projectId });
  const p = scope.policy;
  if (!p) throw new Error(scope.policyError ?? "no policy");
  // What an item pins: the config's workflow, as `startPipeline` takes it.
  const workflow = p.workflow ?? null;
  const agent = (a: { name: string } | null | undefined) => {
    if (!a) return null;
    const { name: _name, ...rest } = a;
    return rest;
  };
  const plans = [];
  for (const size of SIZES)
    for (const domains of [[], ["auth"]]) {
      const plan = planWorkflow(p, workflow, size, JSON.stringify(domains));
      if (!plan) throw new Error("no plan");
      plans.push({
        build: agent(plan.build),
        slots: Object.fromEntries(
          Object.entries(plan.slots).map(([slot, steps]) => [
            slot,
            steps.map((s) => ({ ...s, agent: agent(s.agent) })),
          ]),
        ),
      });
    }
  return {
    plans,
    checks: declaredChecks(p, workflow),
    spec: p.spec,
    retryLimit: p.retryLimit,
    protection: p.protection,
    reviewPacket: p.reviewPacket ?? null,
    autonomy: p.autonomyPolicy,
    overrides: p.overrides,
    approvers: p.approvers,
  };
}

describe("adopting the projects' workflows changes nothing an item does", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`for generated projects (seed ${seed})`, async () => {
      const [head, ...rest] = generate(seed);
      const w = await world(head);
      const ids = [w.projectId];
      for (const [i, policy] of rest.entries()) ids.push(await addProject(w, i, policy));
      const before = await Promise.all(ids.map(behaviour));
      const human = { type: "human" as const, id: w.userId };
      // The real run is bound to the plan its dry run showed (review of #156).
      const { planDigest } = await ok<{ planDigest: string }>(
        "orgConfig.adoptProjectWorkflows",
        { orgId: w.orgId, baseVersion: 0, dryRun: true },
        human,
      );
      const done = await ok<{
        projects: { projectId: string }[];
        skipped: { projectId: string; reason: string }[];
        remaining: string[];
      }>(
        "orgConfig.adoptProjectWorkflows",
        { orgId: w.orgId, baseVersion: 0, dryRun: false, planDigest },
        human,
      );
      // Every project moved, or was left as it is with a reason.
      expect(
        [...done.projects.map((p) => p.projectId), ...done.skipped.map((p) => p.projectId)].sort(),
      ).toEqual([...ids].sort());
      expect(done.remaining).toEqual([]);
      // Nothing these generate is left behind: every project moves.
      expect(done.skipped).toEqual([]);
      expect(await Promise.all(ids.map(behaviour))).toEqual(before);
    });
  }
});
