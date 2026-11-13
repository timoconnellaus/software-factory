// Skills (spec 52 build step (f), ADR 0513): org-owned, versioned, attached to agents and stages;
// a judge's skills are policy (Q16); the factory proposes, a person accepts (Q17); a job carries the
// skills it follows and its runner reads them, fenced by its lease.
import {
  type CapabilityManifest,
  CONTRACT_VERSION,
  type Job,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { type Actor, BUILTIN_SKILLS, type OrgSkill, resolveSkills } from "../src/index.ts";
import { SOFTWARE, type WorkflowDefinition } from "../src/stages/index.ts";
import {
  call,
  FOREMAN,
  first,
  newItem,
  ok,
  POLICY,
  RUNNER_ACTOR,
  refusal,
  rows,
  uid,
  world,
} from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;
const IMPROVER: Actor = { type: "self-improve", id: "improver" };

const skill = (id: string, extra: Partial<OrgSkill> = {}): OrgSkill => ({
  id,
  version: 1,
  name: id.replace("sk_", "").replaceAll("_", " "),
  description: "d",
  sha256: "x",
  overrides: null,
  ...extra,
});

describe("resolveSkills (pure)", () => {
  const facts = { size: "small" as const, domains: [], paths: null };
  it("built-ins first (extended or replaced), then the agent's, then the stage's, deduplicated", () => {
    const ext = skill("sk_our_interviews", {
      overrides: { builtin: "builtin:interview-planning:run-an-interview", mode: "extend" },
    });
    const migration = skill("sk_write_a_migration");
    const out = resolveSkills({
      stageType: "interview-planning",
      orgSkills: new Map([
        [ext.id, ext],
        [migration.id, migration],
      ]),
      agentSkills: [migration.id],
      stageSkills: [{ skill: migration.id }],
      facts,
    });
    expect(out.map((s) => `${s.from}:${s.id}`)).toEqual([
      "builtin:builtin:interview-planning:run-an-interview",
      "builtin:sk_our_interviews",
      "agent:sk_write_a_migration",
    ]);
    const rep = {
      ...ext,
      overrides: {
        builtin: "builtin:interview-planning:run-an-interview",
        mode: "replace" as const,
      },
    };
    const replaced = resolveSkills({
      stageType: "interview-planning",
      orgSkills: new Map([[rep.id, rep]]),
      agentSkills: [],
      stageSkills: [],
      facts,
    });
    expect(replaced.map((s) => s.id)).toEqual(["sk_our_interviews"]);
  });

  it("a stage's condition: paths, size and domain; unknown paths include it", () => {
    const db = skill("sk_db");
    const run = (f: Parameters<typeof resolveSkills>[0]["facts"]) =>
      resolveSkills({
        stageType: "build",
        orgSkills: new Map([[db.id, db]]),
        agentSkills: [],
        stageSkills: [{ skill: db.id, when: { paths: ["packages/db/**"], sizeAtLeast: "small" } }],
        facts: f,
      }).map((s) => s.id);
    expect(run({ size: "small", domains: [], paths: null })).toEqual(["sk_db"]);
    expect(run({ size: "small", domains: [], paths: ["packages/db/src/x.ts"] })).toEqual(["sk_db"]);
    expect(run({ size: "small", domains: [], paths: ["apps/app/x.ts"] })).toEqual([]);
    expect(run({ size: null, domains: [], paths: null })).toEqual([]);
  });

  it("ships built-in skills, and the reviewer's is protected", () => {
    expect(BUILTIN_SKILLS.find((s) => s.type === "checks")?.protected).toBe(true);
  });
});

// ---- Through the operations ----

const SECURITY = {
  id: "security",
  type: "agent-check",
  typeVersion: 1,
  name: "Security review",
  phase: "delivery" as const,
  settings: { instructions: "Look at auth." },
  agent: "Security",
};
const SHIP: WorkflowDefinition = {
  ...SOFTWARE,
  id: "wf_ship",
  name: "Ship",
  template: { id: SOFTWARE.id, version: 1 },
  stages: [...SOFTWARE.stages.slice(0, 3), SECURITY, ...SOFTWARE.stages.slice(3)],
};
const DRAFT = {
  name: "Write a migration",
  description: "How we write D1 migrations.",
  body: "Name the query each index serves.",
};

const orgVersion = async (w: W) =>
  (
    await first<{ config_version: number | null }>(
      "SELECT config_version FROM core_organization WHERE id = ?",
      w.orgId,
    )
  ).config_version ?? 0;

async function decide(w: W, r: Awaited<ReturnType<typeof call>>) {
  if (r.status === "pending")
    await ok(
      "approval.decide",
      { pendingActionId: r.pendingActionId, decision: "approved" },
      w.human,
    );
}

/** The Security agent and the Ship workflow, with the project on it. */
async function onShip(w: W) {
  await ok(
    "agent.save",
    {
      orgId: w.orgId,
      baseVersion: 0,
      agent: { name: "Security", role: "review", tier: "light", instructions: "Be strict." },
    },
    w.human,
  );
  await ok(
    "agent.save",
    {
      orgId: w.orgId,
      baseVersion: 1,
      agent: { name: "Builder", role: "implement", tier: "standard", instructions: "" },
    },
    w.human,
  );
  await decide(
    w,
    await call("workflow.save", { orgId: w.orgId, baseVersion: 2, workflow: SHIP }, w.human),
  );
  const got = await ok<{ current: { version: number } | null }>(
    "config.get",
    { projectId: w.projectId },
    w.human,
  );
  await decide(
    w,
    await call(
      "config.save",
      {
        projectId: w.projectId,
        baseVersion: got.current?.version ?? 0,
        policy: { ...POLICY, workflow: SHIP.id },
      },
      w.human,
    ),
  );
}

async function save(w: W, draft: Record<string, unknown> = DRAFT, skillId?: string) {
  return call<{ version: number }>(
    "skill.save",
    {
      orgId: w.orgId,
      baseVersion: await orgVersion(w),
      skill: draft,
      ...(skillId ? { skillId } : {}),
    },
    w.human,
  );
}

const listed = (w: W) =>
  ok<{
    skills: { id: string; name: string; version: number; builtin: boolean; attachedTo: string[] }[];
    proposals: { skillId: string; version: number }[];
  }>("skill.list", { orgId: w.orgId }, w.human);

describe("skills through the operations", () => {
  it("a person saves a skill and a new version; names are unique; the factory can't save one", async () => {
    const w = await world();
    expect((await save(w)).status).toBe("ok");
    const [mine] = (await listed(w)).skills.filter((s) => !s.builtin);
    expect(mine).toMatchObject({ name: "Write a migration", version: 1 });
    expect((await save(w, { ...DRAFT, body: "Also: no COUNT(*)." }, mine?.id)).status).toBe("ok");
    const got = await ok<{ current: { version: number; body: string }; versions: unknown[] }>(
      "skill.get",
      { orgId: w.orgId, skillId: mine?.id },
      w.human,
    );
    expect(got.current).toMatchObject({ version: 2, body: "Also: no COUNT(*)." });
    expect(got.versions).toHaveLength(2);
    expect((await refusal(save(w))).message).toMatch(/another skill is called/);
    const agent = await refusal(
      call(
        "skill.save",
        { orgId: w.orgId, baseVersion: await orgVersion(w), skill: DRAFT },
        FOREMAN,
      ),
    );
    expect(agent.code).toBe("forbidden");
  });

  it("attaching to a builder is practice; to a judge is policy, and so is editing a skill a judge follows", async () => {
    const w = await world();
    await onShip(w);
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    const attach = async (target: Record<string, unknown>) =>
      call(
        "skill.attach",
        { orgId: w.orgId, baseVersion: await orgVersion(w), skillId: id, target },
        w.human,
      );
    expect((await attach({ agent: "Builder" })).status).toBe("ok");
    expect(
      (await attach({ workflowId: SHIP.id, stageId: "build", when: { paths: ["packages/db/**"] } }))
        .status,
    ).toBe("ok");
    expect((await attach({ agent: "Security" })).status).toBe("pending");
    expect((await attach({ workflowId: SHIP.id, stageId: "security" })).status).toBe("pending");
    expect((await listed(w)).skills.find((s) => s.id === id)?.attachedTo).toEqual([
      "agent builder",
      "Ship → Build",
    ]);
    // Archive is refused while attached.
    expect(
      (
        await refusal(
          call(
            "skill.archive",
            { orgId: w.orgId, baseVersion: await orgVersion(w), skillId: id },
            w.human,
          ),
        )
      ).message,
    ).toMatch(/still attached/);
  });

  it("the reviewer's protected built-in can be added to (a person's decision), never replaced", async () => {
    const w = await world();
    const replace = await refusal(
      save(w, {
        ...DRAFT,
        name: "Our review",
        overrides: { builtin: "builtin:checks:review-the-change", mode: "replace" },
      }),
    );
    expect(replace.message).toMatch(/can't replace Review the change/);
    const extend = await save(w, {
      ...DRAFT,
      name: "Walk the app",
      overrides: { builtin: "builtin:checks:review-the-change", mode: "extend" },
    });
    expect(extend.status).toBe("pending");
  });

  it("the factory proposes; nothing changes until a person accepts", async () => {
    const w = await world();
    const proposed = await ok<{ skillId: string; version: number }>(
      "skill.propose",
      {
        projectId: w.projectId,
        skill: { ...DRAFT, provenance: { note: "from incident #12" } },
        note: "came from incident #12",
      },
      IMPROVER,
    );
    const before = await listed(w);
    expect(before.skills.filter((s) => !s.builtin)).toEqual([]);
    expect(before.proposals).toEqual([
      expect.objectContaining({ skillId: proposed.skillId, version: 1 }),
    ]);
    const self = await refusal(
      call(
        "skill.accept",
        { orgId: w.orgId, baseVersion: await orgVersion(w), skillId: proposed.skillId, version: 1 },
        IMPROVER,
      ),
    );
    expect(self.code).toBe("forbidden");
    await ok(
      "skill.accept",
      { orgId: w.orgId, baseVersion: await orgVersion(w), skillId: proposed.skillId, version: 1 },
      w.human,
    );
    const after = await listed(w);
    expect(after.proposals).toEqual([]);
    expect(after.skills.find((s) => s.id === proposed.skillId)?.version).toBe(1);
  });

  it("a job carries its skills; only its runner reads them, fenced by the lease", async () => {
    const w = await world();
    await onShip(w);
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    await ok(
      "skill.attach",
      {
        orgId: w.orgId,
        baseVersion: await orgVersion(w),
        skillId: id,
        target: { agent: "Builder" },
      },
      w.human,
    );
    // The build stage hands to Builder.
    const def = {
      ...SHIP,
      stages: SHIP.stages.map((s) => (s.id === "build" ? { ...s, agent: "Builder" } : s)),
    };
    await decide(
      w,
      await call(
        "workflow.save",
        { orgId: w.orgId, baseVersion: await orgVersion(w), workflow: def },
        w.human,
      ),
    );
    const item = await newItem(w, uid("skilled "));
    await rows(
      "UPDATE core_work_items SET org_config_version = ? WHERE id = ?",
      await orgVersion(w),
      item.workItemId,
    );
    await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
    await ok(
      "job.enqueue",
      {
        workItemId: item.workItemId,
        stage: "build",
        role: "implement",
        prompt: "Build it",
        context: {},
      },
      FOREMAN,
    );
    const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
    const m5 = RUNNER_ACTOR(r.runnerId);
    const manifest: CapabilityManifest = {
      contractVersion: CONTRACT_VERSION,
      runnerKind: "orca",
      harnesses: ["claude-code"],
      capabilities: ["hooks"],
    };
    const { job } = await ok<{ job: Job | null }>(
      "job.claim",
      { claimId: uid("claim-"), manifest, capacity: { max: 2, inUse: 0, accepting: true } },
      m5,
    );
    const ctx = job?.context as { skills?: { slug: string; from: string }[] };
    expect(ctx.skills?.map((s) => `${s.from}:${s.slug}`)).toEqual(["agent:write-a-migration"]);
    const read = await ok<{ body: string; version: number }>(
      "skill.forJob",
      {
        workItemId: item.workItemId,
        jobId: job?.jobId,
        fencingToken: job?.lease.fencingToken,
        slug: "write-a-migration",
      },
      m5,
    );
    expect(read).toMatchObject({ body: DRAFT.body, version: 1 });
    const stale = await refusal(
      call(
        "skill.forJob",
        {
          workItemId: item.workItemId,
          jobId: job?.jobId,
          fencingToken: (job?.lease.fencingToken ?? 0) + 1,
          slug: "write-a-migration",
        },
        m5,
      ),
    );
    expect(stale.code).toBe("fenced");
    const other = await ok<{ runnerId: string }>("runner.register", { name: "Other" }, w.human);
    const stranger = await refusal(
      call(
        "skill.forJob",
        {
          workItemId: item.workItemId,
          jobId: job?.jobId,
          fencingToken: job?.lease.fencingToken,
          slug: "write-a-migration",
        },
        RUNNER_ACTOR(other.runnerId),
      ),
    );
    expect(stranger.code).toBe("not_found");
  });
});

describe("the improver's instruction edits are proposals (Q17)", () => {
  it("waits for a person; accepted, its trial starts", async () => {
    const ON = { ...POLICY, improve: { enabled: true } };
    const w = await world(ON);
    const base = Number(w.policySha.slice(1));
    const proposed = await call(
      "config.trial.start",
      {
        projectId: w.projectId,
        baseVersion: base,
        kind: "instructions",
        summary: "Tell Builder to run the tests first",
        policy: {
          ...ON,
          agents: [{ name: "Builder", role: "implement", instructions: "Run the tests first." }],
        },
      },
      IMPROVER,
    );
    expect(proposed.status).toBe("pending");
    expect(
      await rows("SELECT id FROM core_config_trials WHERE project_id = ?", w.projectId),
    ).toEqual([]);
    await ok(
      "approval.decide",
      {
        pendingActionId: proposed.status === "pending" ? proposed.pendingActionId : "",
        decision: "approved",
      },
      w.human,
    );
    const trial = await first<{ status: string; created_by: string }>(
      "SELECT status, created_by FROM core_config_trials WHERE project_id = ?",
      w.projectId,
    );
    expect(trial).toMatchObject({ status: "running", created_by: "improver" });
  });
});
