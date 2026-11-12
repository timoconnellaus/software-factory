// Moving each project's slot workflow to the org (spec 52 PR (d), migration): an org admin's one
// run, which must change nothing an item does. A dry run writes nothing; the real one writes one
// org config version and one project config version each, and every project runs the same plan.
import { env } from "cloudflare:workers";
import { createDb } from "@software-factory/db";
import { describe, expect, it } from "vitest";
import { invoke, type OperationError, parseProjectPolicy, resolveScope } from "../src/index.ts";
import { ADOPT_PER_RUN } from "../src/operations/adopt.ts";
import { compileProjectWorkflow, planFromDefinition } from "../src/stages/index.ts";
import {
  call,
  deps,
  FOREMAN,
  first,
  ok,
  onboard,
  POLICY,
  RUNNER_ACTOR,
  refusal,
  rows,
  uid,
  world,
} from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;

const AGENTS = [
  { name: "Security", role: "review", instructions: "Send back auth changes without tests." },
];
const FEATURE = {
  name: "Ship a feature",
  slots: {
    beforeVerify: [{ id: "security", kind: "work", name: "Security review", agent: "Security" }],
    afterVerify: [{ id: "design", kind: "gate", name: "Design sign-off" }],
  },
};
/** Today's config: its own slot workflow, a looser spec size and a higher retry limit than Software's. */
const TODAY = {
  ...POLICY,
  spec: { requiredFrom: "large" },
  retryLimit: 4,
  agents: AGENTS,
  workflows: [FEATURE],
  workflow: "Ship a feature",
};

async function saveConfig(w: W, projectId: string, policy: Record<string, unknown>) {
  const got = await ok<{ current: { version: number } | null }>(
    "config.get",
    { projectId },
    w.human,
  );
  return call(
    "config.save",
    { projectId, baseVersion: got.current?.version ?? 0, policy },
    w.human,
  );
}

async function project(w: W, name: string, policy: Record<string, unknown>) {
  const { project: p } = await onboard(
    w.human,
    w.orgId,
    { owner: "timoconnellaus", name: uid("r-") },
    name,
  );
  const saved = await saveConfig(w, p.id, policy);
  if (saved.status !== "ok")
    await ok(
      "approval.decide",
      { pendingActionId: saved.pendingActionId, decision: "approved" },
      w.human,
    );
  return p.id;
}

type Plan = ReturnType<typeof planFromDefinition>;
/** What the engine plans for each size and domain set, from the config the scope resolves. */
async function plans(projectId: string): Promise<Plan[]> {
  const scope = await resolveScope(createDb(env.DB), { projectId });
  const policy = scope.policy;
  if (!policy) throw new Error(scope.policyError ?? "no policy");
  const out: Plan[] = [];
  for (const size of ["small", "medium", "large"] as const)
    for (const domains of [[], ["auth"]])
      out.push({
        ...planFromDefinition(
          compileProjectWorkflow(policy, policy.workflow),
          policy.agents,
          size,
          domains,
          null,
        ),
        name: null,
      });
  return out;
}

const behaviour = async (projectId: string) => {
  const scope = await resolveScope(createDb(env.DB), { projectId });
  const p = scope.policy;
  return {
    plans: await plans(projectId),
    spec: p?.spec.requiredFrom,
    retryLimit: p?.retryLimit,
    checks: p?.protection.requiredChecks,
    sections: p?.reviewPacket?.sections ?? null,
    autonomy: p?.autonomyPolicy,
  };
};

const adopt = (w: W, dryRun: boolean, baseVersion = 0) =>
  ok<{
    dryRun: boolean;
    orgVersion: number | null;
    workflows: { id: string; name: string; added: boolean; projects: string[] }[];
    agents: string[];
    projects: {
      name: string;
      from: string | null;
      workflow: string;
      overrides: Record<string, Record<string, unknown>>;
      changes: { class: string }[];
    }[];
    skipped: { name: string; reason: string }[];
    remaining: string[];
  }>("orgConfig.adoptProjectWorkflows", { orgId: w.orgId, baseVersion, dryRun }, w.human);

describe("orgConfig.adoptProjectWorkflows", () => {
  it("a dry run reports what it would write and writes nothing", async () => {
    const w = await world(TODAY);
    const plan = await adopt(w, true);
    expect(plan).toMatchObject({
      dryRun: true,
      orgVersion: 1,
      workflows: [
        {
          id: "wf_ship_a_feature",
          name: "Ship a feature",
          added: true,
          projects: ["Software factory"],
        },
      ],
      agents: ["Security"],
      projects: [
        {
          name: "Software factory",
          from: "Ship a feature",
          workflow: "wf_ship_a_feature",
          overrides: { spec: { requiredFrom: "large" }, build: { retryLimit: 4 } },
        },
      ],
      skipped: [],
    });
    expect(plan.projects[0]?.changes.every((c) => c.class === "neutral")).toBe(true);
    const org = await first<{ config_version: number | null }>(
      "SELECT config_version FROM core_organization WHERE id = ?",
      w.orgId,
    );
    expect(org.config_version).toBeNull();
  });

  it("moves each project onto an org workflow, and nothing an item does changes", async () => {
    const w = await world(TODAY);
    // A second project with the same workflow shares it; a third whose same-named workflow differs
    // gets its own, with the project's slug; a fourth on the skeleton names Software itself.
    const twin = await project(w, "Twin", { ...TODAY, retryLimit: 2 });
    const other = await project(w, "Other", {
      ...TODAY,
      workflows: [{ ...FEATURE, slots: { afterVerify: FEATURE.slots.afterVerify } }],
    });
    const plain = await project(w, "Plain", POLICY);
    const ids = [w.projectId, twin, other, plain];
    const before = await Promise.all(ids.map(behaviour));

    const done = await adopt(w, false);
    expect(done.skipped).toEqual([]);
    const on = (name: string) => done.projects.find((p) => p.name === name)?.workflow;
    // The same workflow is shared; a different one under the same name gets its own id.
    expect(on("Twin")).toBe(on("Software factory"));
    expect(on("Other")).not.toBe(on("Software factory"));
    expect([on("Other"), on("Software factory")]).toContain("wf_ship_a_feature");
    expect(on("Plain")).toBe("wf_software");
    // Each project's own values are its overrides: only where they differ from Software's (Twin's
    // retry limit of 2 is Software's own, so it isn't one).
    expect(done.projects.find((p) => p.name === "Twin")?.overrides).toEqual({
      spec: { requiredFrom: "large" },
    });
    expect(done.projects.find((p) => p.name === "Software factory")?.overrides).toEqual({
      spec: { requiredFrom: "large" },
      build: { retryLimit: 4 },
    });
    // The same behaviour after as before, project by project.
    expect(await Promise.all(ids.map(behaviour))).toEqual(before);
    // Each project's config names its org workflow; the org has one migrated version.
    for (const id of ids) {
      const scope = await resolveScope(createDb(env.DB), { projectId: id });
      expect(scope.rawPolicy?.workflow).toMatch(/^wf_/);
    }
    const versions = await rows<{ source: string }>(
      "SELECT source FROM core_org_configs WHERE org_id = ?",
      w.orgId,
    );
    expect(versions).toEqual([{ source: "migrated" }]);
    // The looser values are approved by this run, as the factory's record, for the version written.
    expect(
      await rows(
        "SELECT org_version, stage_id, setting, value FROM core_override_approvals WHERE project_id = ?",
        w.projectId,
      ),
    ).toEqual([{ org_version: 1, stage_id: "spec", setting: "requiredFrom", value: '"large"' }]);
    // Run again: nothing left to adopt.
    const again = await adopt(w, false, 1);
    expect(again).toMatchObject({ orgVersion: null, projects: [] });
  });

  it("keeps a project's own agent apart from a same-named, different org agent", async () => {
    const w = await world(TODAY);
    await project(w, "Strict", {
      ...TODAY,
      agents: [{ ...AGENTS[0], instructions: "Be strict about everything." }],
    });
    const done = await adopt(w, false);
    expect(done.agents).toEqual(["Security", "Security (strict)"]);
    expect(done.skipped).toEqual([]);
  });

  it("is an org admin's, from the app only", async () => {
    const w = await world(TODAY);
    const now = new Date().toISOString();
    const memberId = uid("usr_");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, 'M', ?, ?, ?, ?)",
      ).bind(memberId, `${memberId}@example.com`, `gh-${memberId}`, now, now),
      env.DB.prepare(
        "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      ).bind(uid("mem_"), w.orgId, memberId, now),
    ]);
    const refused = await refusal(
      call(
        "orgConfig.adoptProjectWorkflows",
        { orgId: w.orgId, baseVersion: 0, dryRun: true },
        { type: "human", id: memberId },
      ),
    );
    expect(refused.code).toBe("forbidden");
    // The adopted config parses as a project config.
    await adopt(w, false);
    const scope = await resolveScope(createDb(env.DB), { projectId: w.projectId });
    expect(parseProjectPolicy(JSON.stringify(scope.rawPolicy)).ok).toBe(true);
  });

  it("refuses an agent, a runner, and a CLI or MCP token", async () => {
    const w = await world(TODAY);
    const input = { orgId: w.orgId, baseVersion: 0, dryRun: true };
    for (const actor of [FOREMAN, RUNNER_ACTOR(uid("run_"))]) {
      const refused = await refusal(call("orgConfig.adoptProjectWorkflows", input, actor));
      expect(refused.code).toBe("forbidden");
    }
    for (const surface of ["cli", "mcp"] as const) {
      const refused = await invoke(deps, "orgConfig.adoptProjectWorkflows", input, {
        actor: w.human,
        origin: { surface },
      }).catch((e: OperationError) => e);
      expect((refused as OperationError).code).toBe("forbidden");
    }
  });

  it("leaves a project whose workflow would loosen against the floor, and moves the rest", async () => {
    const w = await world(TODAY);
    // Its agent check runs only for auth work.
    await project(w, "Conditional", {
      ...TODAY,
      workflows: [
        {
          ...FEATURE,
          name: "Auth only",
          slots: {
            ...FEATURE.slots,
            beforeVerify: [{ ...FEATURE.slots.beforeVerify[0], when: { domain: "auth" } }],
          },
        },
      ],
      workflow: "Auth only",
    });
    const done = await adopt(w, false);
    expect(done.projects.map((p) => p.name)).toEqual(["Software factory"]);
    expect(done.skipped).toEqual([
      {
        projectId: expect.any(String),
        name: "Conditional",
        reason: expect.stringMatching(/loosen/),
      },
    ]);
    expect(done.workflows.map((x) => x.name)).toEqual(["Ship a feature"]);
  });

  it("leaves a project whose workflow declares its own checks", async () => {
    const w = await world({
      ...TODAY,
      workflows: [{ ...FEATURE, checks: [{ name: "e2e", run: "pnpm e2e" }] }],
    });
    const done = await adopt(w, false);
    expect(done.projects).toEqual([]);
    expect(done.skipped[0]?.reason).toMatch(/declares its own checks/);
  });

  it("moves at most ADOPT_PER_RUN projects a run; the next run moves the rest", async () => {
    const w = await world(TODAY);
    for (let i = 0; i < ADOPT_PER_RUN; i++) await project(w, `P${i}`, TODAY);
    const one = await adopt(w, false);
    expect(one.projects).toHaveLength(ADOPT_PER_RUN);
    expect(one.remaining).toHaveLength(1);
    const second = await adopt(w, false, 1);
    expect(second.projects.map((p) => p.name)).toEqual(one.remaining);
    expect(second.remaining).toEqual([]);
  });
});
