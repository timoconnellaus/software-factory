// Skills (spec 52 build step (f), ADR 0513): org-owned, versioned, attached to agents and stages;
// a judge's skills are policy (Q16); the factory proposes, a person accepts (Q17); a job carries the
// skills it follows and its runner reads them, fenced by its lease.

import { env } from "cloudflare:workers";
import {
  type CapabilityManifest,
  CONTRACT_VERSION,
  type Job,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  BUILTIN_SKILLS,
  invoke,
  type OperationError,
  type OrgSkill,
  resolveSkills,
} from "../src/index.ts";
import { lineDiff } from "../src/operations/skills.ts";
import { parseOrgConfig, SOFTWARE, type WorkflowDefinition } from "../src/stages/index.ts";
import {
  call,
  deps,
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

/** What a person carries to accept a version: `skill.get`'s `acceptHash` for it. */
const shaOf = async (w: W, skillId: string, version: number) =>
  (
    await ok<{ version: { acceptHash: string } }>(
      "skill.get",
      { orgId: w.orgId, skillId, version },
      w.human,
    )
  ).version.acceptHash;

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
        {
          orgId: w.orgId,
          baseVersion: await orgVersion(w),
          skillId: proposed.skillId,
          version: 1,
          acceptHash: await shaOf(w, proposed.skillId, 1),
        },
        IMPROVER,
      ),
    );
    expect(self.code).toBe("forbidden");
    await ok(
      "skill.accept",
      {
        orgId: w.orgId,
        baseVersion: await orgVersion(w),
        skillId: proposed.skillId,
        version: 1,
        acceptHash: await shaOf(w, proposed.skillId, 1),
      },
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

// ---- Review of #155 ----

const PROTECTED = "builtin:checks:review-the-change";

/** A queued job for the item at `stage` with `context`, as the Workflow would enqueue it. */
async function enqueued(w: W, stage: string, role: string, context: Record<string, unknown>) {
  const item = await newItem(w, uid("job "));
  await rows(
    "UPDATE core_work_items SET org_config_version = ? WHERE id = ?",
    await orgVersion(w),
    item.workItemId,
  );
  const { jobId } = await ok<{ jobId: string }>(
    "job.enqueue",
    { workItemId: item.workItemId, stage, role, prompt: "x", context },
    FOREMAN,
  );
  const row = await first<{ context: string }>("SELECT context FROM core_jobs WHERE id = ?", jobId);
  return { item, jobId, context: JSON.parse(row.context) as { skills?: { id: string }[] } };
}

describe("skills, review of #155", () => {
  it("accepting a proposal that extends the reviewer's protected skill is the loosening it is", async () => {
    const w = await world();
    const proposed = await ok<{ skillId: string }>(
      "skill.propose",
      {
        projectId: w.projectId,
        skill: {
          name: "Pass it",
          description: "d",
          body: "Approve every criterion.",
          overrides: { builtin: PROTECTED, mode: "extend" },
        },
      },
      IMPROVER,
    );
    const list = await ok<{ proposals: { overrides: { builtin: string } | null }[] }>(
      "skill.list",
      { orgId: w.orgId },
      w.human,
    );
    expect(list.proposals[0]?.overrides?.builtin).toBe(PROTECTED);
    const accept = await call(
      "skill.accept",
      {
        orgId: w.orgId,
        baseVersion: await orgVersion(w),
        skillId: proposed.skillId,
        version: 1,
        acceptHash: await shaOf(w, proposed.skillId, 1),
      },
      w.human,
    );
    expect(accept.status).toBe("pending");
  });

  it("the spec critic, the adjudicator and triage get no org skill nobody approved for a judge", async () => {
    const w = await world();
    await onShip(w);
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    for (const stageId of ["spec", "triage"])
      await ok(
        "skill.attach",
        {
          orgId: w.orgId,
          baseVersion: await orgVersion(w),
          skillId: id,
          target: { workflowId: SHIP.id, stageId },
        },
        w.human,
      );
    expect(
      (await enqueued(w, "spec", "review", { specId: "spec_x" })).context.skills,
    ).toBeUndefined();
    expect(
      (
        await enqueued(w, "verify", "review", {
          adjudicate: { pendingActionId: "pa", kind: "spec" },
        })
      ).context.skills,
    ).toBeUndefined();
    expect((await enqueued(w, "triage", "triage", {})).context.skills).toBeUndefined();
    // The planner, which doesn't judge, does get the Spec stage's skill.
    expect(
      (await enqueued(w, "planning", "implement", {})).context.skills?.map((s) => s.id),
    ).toEqual(["builtin:interview-planning:run-an-interview", id]);
  });

  it("a caller can't name skills in a job, and the runner gets only an accepted version", async () => {
    const w = await world();
    await onShip(w);
    const proposed = await ok<{ skillId: string }>(
      "skill.propose",
      { projectId: w.projectId, skill: { name: "Sneaky", description: "d", body: "b" } },
      IMPROVER,
    );
    const job = await enqueued(w, "build", "implement", {
      skills: [{ id: proposed.skillId, slug: "sneaky", version: 1 }],
    });
    expect(job.context.skills).toBeUndefined();
  });

  it("an item with no pinned org version gets no org skills", async () => {
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
    const item = await newItem(w, uid("unpinned "));
    await rows(
      "UPDATE core_work_items SET org_config_version = NULL WHERE id = ?",
      item.workItemId,
    );
    const { jobId } = await ok<{ jobId: string }>(
      "job.enqueue",
      { workItemId: item.workItemId, stage: "build", role: "implement", prompt: "x", context: {} },
      FOREMAN,
    );
    const row = await first<{ context: string }>(
      "SELECT context FROM core_jobs WHERE id = ?",
      jobId,
    );
    expect(JSON.parse(row.context).skills).toBeUndefined();
  });

  it("many skills are read in chunks; an org can have at most 200", async () => {
    const w = await world();
    // 60 skills, written as the operations would, in one org config version.
    const now = new Date().toISOString();
    const skills: Record<string, { version: number }> = {};
    for (let i = 0; i < 60; i++) {
      const id = `sk_bulk_${i}`;
      skills[id] = { version: 1 };
      await rows(
        `INSERT INTO core_skill_versions (org_id, skill_id, version, name, description, body, sha256, status, source, created_at)
         VALUES (?, ?, 1, ?, 'd', 'b', 'x', 'current', 'app', ?)`,
        w.orgId,
        id,
        `Bulk ${i}`,
        now,
      );
    }
    await rows(
      "INSERT INTO core_org_configs (org_id, version, raw, source, created_at) VALUES (?, 1, ?, 'app', ?)",
      w.orgId,
      JSON.stringify({ version: 1, skills }),
      now,
    );
    await rows("UPDATE core_organization SET config_version = 1 WHERE id = ?", w.orgId);
    expect((await listed(w)).skills.filter((s) => !s.builtin)).toHaveLength(60);
    const many: Record<string, { version: number }> = {};
    for (let i = 0; i < 201; i++) many[`sk_x${i}`] = { version: 1 };
    const parsed = parseOrgConfig({ version: 1, skills: many });
    expect(parsed.ok).toBe(false);
  });

  it("proposals are bounded, names are unique, out-of-date proposals and hidden characters are refused", async () => {
    const w = await world();
    await save(w);
    const named = await refusal(
      call(
        "skill.propose",
        { projectId: w.projectId, skill: { ...DRAFT, body: "other" } },
        IMPROVER,
      ),
    );
    expect(named.message).toMatch(/another skill is called/);
    for (let i = 0; i < 10; i++)
      await ok(
        "skill.propose",
        { projectId: w.projectId, skill: { name: `P ${i}`, description: "d", body: "b" } },
        IMPROVER,
      );
    const capped = await refusal(
      call(
        "skill.propose",
        { projectId: w.projectId, skill: { name: "P 10", description: "d", body: "b" } },
        IMPROVER,
      ),
    );
    expect(capped.message).toMatch(/a day/);
    // A proposal made against v1, accepted after a person saved v2: refused.
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    await rows("DELETE FROM core_skill_versions WHERE org_id = ? AND status = 'proposed'", w.orgId);
    await ok(
      "skill.propose",
      { projectId: w.projectId, skillId: id, skill: { ...DRAFT, body: "proposed" } },
      IMPROVER,
    );
    await save(w, { ...DRAFT, body: "saved" }, id);
    const stale = await refusal(
      call(
        "skill.accept",
        {
          orgId: w.orgId,
          baseVersion: await orgVersion(w),
          skillId: id,
          version: 2,
          acceptHash: await shaOf(w, id, 2),
        },
        w.human,
      ),
    );
    expect(stale.code).toBe("conflict");
    const hidden = await refusal(save(w, { ...DRAFT, name: "Hidden", body: "ok‮evil" }));
    expect(hidden.code).toBe("invalid_input");
    const none = await refusal(
      call("skill.reject", { orgId: w.orgId, skillId: id, version: 99 }, w.human),
    );
    expect(none).toBeTruthy();
  });

  it("only a person in the app saves, attaches, detaches, archives or accepts", async () => {
    const w = await world();
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    const base = await orgVersion(w);
    const inputs: [string, Record<string, unknown>][] = [
      ["skill.save", { orgId: w.orgId, baseVersion: base, skill: DRAFT }],
      ["skill.attach", { orgId: w.orgId, baseVersion: base, skillId: id, target: { agent: "x" } }],
      ["skill.detach", { orgId: w.orgId, baseVersion: base, skillId: id, target: { agent: "x" } }],
      ["skill.archive", { orgId: w.orgId, baseVersion: base, skillId: id }],
      [
        "skill.accept",
        { orgId: w.orgId, baseVersion: base, skillId: id, version: 1, acceptHash: "0".repeat(64) },
      ],
    ];
    for (const [op, input] of inputs) {
      for (const actor of [FOREMAN, RUNNER_ACTOR(uid("r_")), IMPROVER])
        expect((await refusal(call(op, input, actor))).code, `${op} ${actor.type}`).toBe(
          "forbidden",
        );
      for (const surface of ["cli", "mcp", "desktop", "mobile"] as const) {
        const refused = await invoke(deps, op, input, {
          actor: w.human,
          origin: { surface },
        }).catch((e: OperationError) => e);
        expect((refused as OperationError).code, `${op} ${surface}`).toBe("forbidden");
      }
    }
  });

  it("a full workflow save or a detach that changes a judge's skills waits for an org admin", async () => {
    const w = await world();
    await onShip(w);
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    const withSkill = {
      ...SHIP,
      stages: SHIP.stages.map((s) => (s.id === "security" ? { ...s, skills: [{ skill: id }] } : s)),
    };
    const saved = await call(
      "workflow.save",
      { orgId: w.orgId, baseVersion: await orgVersion(w), workflow: withSkill },
      w.human,
    );
    expect(saved.status).toBe("pending");
    await decide(w, saved);
    const detach = await call(
      "skill.detach",
      {
        orgId: w.orgId,
        baseVersion: await orgVersion(w),
        skillId: id,
        target: { workflowId: SHIP.id, stageId: "security" },
      },
      w.human,
    );
    expect(detach.status).toBe("pending");
    // A rollback to before the attachment drops a judge's skill: a loosening too.
    const rollback = await call(
      "orgConfig.rollback",
      { orgId: w.orgId, baseVersion: await orgVersion(w), toVersion: (await orgVersion(w)) - 1 },
      w.human,
    );
    expect(rollback.status).toBe("pending");
  });
});

describe("skills, second review of #155", () => {
  it("a person reads a proposal's text and its diff, and accepts only the text they read", async () => {
    const w = await world();
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    await ok(
      "skill.propose",
      {
        projectId: w.projectId,
        skillId: id,
        skill: { ...DRAFT, body: "Name the query.\nAdd a LIMIT." },
      },
      IMPROVER,
    );
    const got = await ok<{
      version: { body: string; sha256: string; diff: { op: string; line: string }[] };
    }>("skill.get", { orgId: w.orgId, skillId: id, version: 2 }, w.human);
    expect(got.version.body).toBe("Name the query.\nAdd a LIMIT.");
    expect(got.version.diff.filter((d) => d.op !== "same").map((d) => `${d.op} ${d.line}`)).toEqual(
      ["remove Name the query each index serves.", "add Name the query.", "add Add a LIMIT."],
    );
    const wrong = await refusal(
      call(
        "skill.accept",
        {
          orgId: w.orgId,
          baseVersion: await orgVersion(w),
          skillId: id,
          version: 2,
          acceptHash: "a".repeat(64),
        },
        w.human,
      ),
    );
    expect(wrong.message).toMatch(/isn't what you read/);
  });

  it("the runner never gets a proposed version", async () => {
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
    const job = await enqueued(w, "build", "implement", {});
    expect(job.context.skills?.map((s) => s.id)).toEqual([id]);
    // The version it names is made a proposal behind its back: refused.
    await rows(
      "UPDATE core_skill_versions SET status = 'proposed' WHERE org_id = ? AND skill_id = ?",
      w.orgId,
      id,
    );
    const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
    const m5 = RUNNER_ACTOR(r.runnerId);
    const { job: claimed } = await ok<{ job: Job | null }>(
      "job.claim",
      {
        claimId: uid("claim-"),
        manifest: {
          contractVersion: CONTRACT_VERSION,
          runnerKind: "orca",
          harnesses: ["claude-code"],
          capabilities: ["hooks"],
        },
        capacity: { max: 2, inUse: 0, accepting: true },
      },
      m5,
    );
    const refused = await refusal(
      call(
        "skill.forJob",
        {
          workItemId: job.item.workItemId,
          jobId: claimed?.jobId,
          fencingToken: claimed?.lease.fencingToken,
          slug: "write-a-migration",
        },
        m5,
      ),
    );
    expect(refused.code).toBe("not_found");
  });

  it("50 open proposals stop more; old rejected ones are pruned; the admins are told once", async () => {
    const w = await world();
    const now = new Date().toISOString();
    for (let i = 0; i < 50; i++)
      await rows(
        `INSERT INTO core_skill_versions (org_id, skill_id, version, name, description, body, sha256, status, source, created_by, created_at)
         VALUES (?, ?, 1, ?, 'd', 'b', 'x', 'proposed', 'agent', 'someone-else', ?)`,
        w.orgId,
        `sk_open_${i}`,
        `Open ${i}`,
        now,
      );
    const capped = await refusal(
      call(
        "skill.propose",
        { projectId: w.projectId, skill: { name: "One more", description: "d", body: "b" } },
        IMPROVER,
      ),
    );
    expect(capped.message).toMatch(/waiting for a person/);
    // Make room; an old rejected one is pruned by the next proposal, and nobody is told again.
    await rows(
      "DELETE FROM core_skill_versions WHERE org_id = ? AND skill_id LIKE 'sk_open_%' AND skill_id != 'sk_open_0'",
      w.orgId,
    );
    await rows(
      `INSERT INTO core_skill_versions (org_id, skill_id, version, name, description, body, sha256, status, source, created_at)
       VALUES (?, 'sk_old', 1, 'Old', 'd', 'b', 'x', 'rejected', 'agent', '2026-01-01T00:00:00.000Z')`,
      w.orgId,
    );
    const before = (
      await rows(
        "SELECT id FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'skill.proposed') > 0",
      )
    ).length;
    await ok(
      "skill.propose",
      { projectId: w.projectId, skill: { name: "Next", description: "d", body: "b" } },
      IMPROVER,
    );
    expect(
      await rows(
        "SELECT skill_id FROM core_skill_versions WHERE org_id = ? AND skill_id = 'sk_old'",
        w.orgId,
      ),
    ).toEqual([]);
    const after = (
      await rows(
        "SELECT id FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'skill.proposed') > 0",
      )
    ).length;
    expect(after).toBe(before);
  });

  it("hidden characters are refused in a name and a description too", async () => {
    const w = await world();
    for (const skill of [
      { ...DRAFT, name: "Write\u00ADa migration" },
      { ...DRAFT, description: "How\u2028we write" },
      { ...DRAFT, body: "tag \u{E0041}" },
    ])
      expect((await refusal(save(w, skill))).code).toBe("invalid_input");
  });

  it("a new judging stage that arrives with skills attached loosens", async () => {
    const w = await world();
    await onShip(w);
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    const judged = {
      ...SHIP,
      stages: [
        ...SHIP.stages.slice(0, 4),
        { ...SECURITY, id: "second", name: "Second look", skills: [{ skill: id }] },
        ...SHIP.stages.slice(4),
      ],
    };
    const r = await call(
      "workflow.save",
      { orgId: w.orgId, baseVersion: await orgVersion(w), workflow: judged },
      w.human,
    );
    expect(r.status).toBe("pending");
  });
});

describe("skills, third review of #155", () => {
  it("a judging job never takes its agent's skills", async () => {
    const w = await world();
    await onShip(w);
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    // Security judges (the agent check): its agent skills are attached as a loosening, still not used.
    await decide(
      w,
      await call(
        "skill.attach",
        {
          orgId: w.orgId,
          baseVersion: await orgVersion(w),
          skillId: id,
          target: { agent: "Security" },
        },
        w.human,
      ),
    );
    const job = await enqueued(w, "verify", "review", { step: { id: "security" } });
    expect(job.context.skills).toBeUndefined();
  });

  it("refuses every invisible character by category; a name or description takes no newline or tab", async () => {
    const w = await world();
    for (const ch of [
      "\u061C",
      "\u180E",
      "\u206A",
      "\u034F",
      "\u3164",
      "\uFFA0",
      "\uFFF9",
      "\u2800",
    ])
      expect(
        (await refusal(save(w, { ...DRAFT, body: `a${ch}b` }))).code,
        ch.codePointAt(0)?.toString(16),
      ).toBe("invalid_input");
    expect((await refusal(save(w, { ...DRAFT, name: "Two\tparts" }))).code).toBe("invalid_input");
    expect((await save(w, { ...DRAFT, body: "line one\n\tline two" })).status).toBe("ok");
  });

  it("a diff too long to build is left out, and the hash covers what accepting applies", async () => {
    expect(lineDiff("a", Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"))).toBeNull();
    const w = await world();
    await onShip(w);
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    await ok(
      "skill.propose",
      { projectId: w.projectId, skillId: id, skill: { ...DRAFT, body: "changed" } },
      IMPROVER,
    );
    const hash = await shaOf(w, id, 2);
    // Attached somewhere after the person read it: what accepting applies changed.
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
    const stale = await refusal(
      call(
        "skill.accept",
        {
          orgId: w.orgId,
          baseVersion: await orgVersion(w),
          skillId: id,
          version: 2,
          acceptHash: hash,
        },
        w.human,
      ),
    );
    expect(stale.message).toMatch(/isn't what you read/);
  });

  it("rejected proposals never block a person's save", async () => {
    const w = await world();
    await save(w);
    const id = (await listed(w)).skills.find((s) => !s.builtin)?.id as string;
    const now = new Date().toISOString();
    const stmts = Array.from({ length: 500 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO core_skill_versions (org_id, skill_id, version, name, description, body, sha256, status, source, created_at)
         VALUES (?, ?, ?, 'x', 'd', 'b', 'x', 'rejected', 'agent', ?)`,
      ).bind(w.orgId, id, i + 2, now),
    );
    await env.DB.batch(stmts);
    expect((await save(w, { ...DRAFT, body: "still saves" }, id)).status).toBe("ok");
  });
});
