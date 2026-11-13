// Skills (spec 52 build step (f), ADR 0513): how the team does one thing, written once, owned by
// the org, attached to agents and stages. Versions are rows (`core_skill_versions`, migration 0283);
// the org config version names each skill's current version and its attachments, so a skill change
// goes through the org config's impact check: practice, unless a judge follows the skill (Q16).
//
// The owner's rule: the factory may propose an edit; only a person accepts one (`skill.propose`,
// `skill.accept`). A job carries the skills it follows as references (`skills` in its context), and
// its runner reads each body over the channel (`skill.forJob`), fenced by the job's lease.
import type { Db } from "@software-factory/db";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext, type WorkItemRow } from "../operation.ts";
import { onOrgWorkflow, type ProjectPolicy } from "../policy/project-policy.ts";
import { BUILTIN_BY_ID, BUILTIN_SKILLS } from "../skills/builtin.ts";
import { type OrgSkill, type ResolvedSkill, resolveSkills } from "../skills/resolve.ts";
import {
  MAX_OPEN_PROPOSALS,
  MAX_PROPOSALS_A_DAY,
  MAX_SKILL_VERSIONS,
  type SkillDraft,
  skillConditionSchema,
  skillDraftSchema,
  skillIdSchema,
  skillSlug,
} from "../skills/schema.ts";
import { slotStepId } from "../stages/compile.ts";
import type { Size } from "../stages/contract.ts";
import type { OrgConfig } from "../stages/org-config.ts";
import { resolveProjectWorkflow } from "../stages/project-workflow.ts";
import { stageType } from "../stages/registry.ts";
import type { StageInstance, WorkflowDefinition } from "../stages/workflow.ts";
import { fencingToken, jobId, projectId, requireProject, workItemId } from "./shared.ts";
import {
  currentOrgConfig,
  requireBase,
  riskOfSave,
  SKILL_WRITES,
  type SkillWrite,
  storedOrgConfig,
  validated,
  writeOrgVersion,
} from "./workflows.ts";

const orgId = z.string().min(1);
const baseVersion = z.number().int().nonnegative();
const note = z.string().trim().max(500).optional();

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const newSkillId = () => `sk_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;

/** The highest version a skill has, or 0 (by the primary key's prefix). */
async function latestVersion(db: Db, org: string, skill: string): Promise<number> {
  const row = await db
    .selectFrom("core_skill_versions")
    .select("version")
    .where("org_id", "=", org)
    .where("skill_id", "=", skill)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.version ?? 0;
}

/**
 * The skills' rows at the versions an org config names (primary key reads), in chunks so no query
 * binds too many values (review of #155), with or without their bodies.
 */
async function versionsOf(
  db: Db,
  org: string,
  wanted: readonly { id: string; version: number }[],
  withBody = true,
): Promise<Map<string, OrgSkill & { body: string; status: string }>> {
  const out = new Map<string, OrgSkill & { body: string; status: string }>();
  for (let i = 0; i < wanted.length; i += VERSION_CHUNK) {
    const chunk = wanted.slice(i, i + VERSION_CHUNK);
    const rows = await db
      .selectFrom("core_skill_versions")
      .select([
        "skill_id",
        "version",
        "name",
        "description",
        "sha256",
        "overrides",
        "status",
        ...(withBody ? (["body"] as const) : []),
      ])
      // org_id inside each arm, so each is a primary-key lookup (MULTI-INDEX OR on the full key),
      // never a walk of the org's version history (review of #155).
      .where((eb) =>
        eb.or(
          chunk.map((w) =>
            eb.and([
              eb("org_id", "=", org),
              eb("skill_id", "=", w.id),
              eb("version", "=", w.version),
            ]),
          ),
        ),
      )
      .limit(chunk.length)
      .execute();
    for (const r of rows)
      out.set(r.skill_id, {
        id: r.skill_id,
        version: r.version,
        name: r.name,
        description: r.description,
        sha256: r.sha256,
        overrides: r.overrides ? (JSON.parse(r.overrides) as OrgSkill["overrides"]) : null,
        body: (r as { body?: string }).body ?? "",
        status: r.status,
      });
  }
  return out;
}
/** Skill keys a query binds at most (three values each: 90, under D1's 100). */
const VERSION_CHUNK = 30;

/** Where a skill is attached in a config: agents and stages, for people and for archive's check. */
function attachments(config: OrgConfig, skill: string): string[] {
  const out: string[] = [];
  for (const [agent, ids] of Object.entries(config.agentSkills))
    if (ids.includes(skill)) out.push(`agent ${agent}`);
  for (const w of [...config.workflows, ...Object.values(config.builtIns)])
    for (const s of w?.stages ?? [])
      if ((s.skills ?? []).some((a) => a.skill === skill)) out.push(`${w?.name} → ${s.name}`);
  return out;
}

function draftRow(
  ctx: HandlerContext,
  org: string,
  skill: string,
  version: number,
  draft: SkillDraft,
  digest: string,
  status: "current" | "proposed",
  extra: { source: string; note: string | null; createdBy?: string; parent: number | null },
) {
  ctx.write(
    ctx.db.insertInto("core_skill_versions").values({
      org_id: org,
      skill_id: skill,
      version,
      name: draft.name,
      description: draft.description,
      body: draft.body,
      sha256: digest,
      overrides: draft.overrides ? JSON.stringify(draft.overrides) : null,
      provenance: draft.provenance ? JSON.stringify(draft.provenance) : null,
      status,
      source: extra.source,
      created_by: extra.createdBy ?? ctx.actor.id,
      note: extra.note,
      parent_version: extra.parent,
      created_at: ctx.now,
    }),
  );
}

/** The skills map with `skill` at `version` (and its override), validated as a whole document. */
function withSkill(
  config: OrgConfig,
  skill: string,
  version: number,
  overrides: SkillDraft["overrides"],
): OrgConfig {
  return {
    ...config,
    skills: { ...config.skills, [skill]: { version, ...(overrides ? { overrides } : {}) } },
  };
}

type SaveInput = {
  orgId: string;
  baseVersion: number;
  skillId?: string | undefined;
  skill: SkillDraft;
  note?: string | undefined;
};

async function saveSkill(ctx: HandlerContext, input: SaveInput, createdBy?: string) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  const id = input.skillId ?? newSkillId();
  const latest = await latestVersion(ctx.db, input.orgId, id);
  if (latest >= MAX_SKILL_VERSIONS)
    throw new OperationError(
      "invalid_input",
      `a skill keeps at most ${MAX_SKILL_VERSIONS} versions`,
    );
  if (input.skillId && !config.skills[input.skillId])
    throw new OperationError("not_found", `the org has no skill ${input.skillId}`);
  const names = await currentNames(ctx.db, input.orgId, config, id);
  if (names.has(skillSlug(input.skill.name)))
    throw new OperationError("invalid_input", `another skill is called "${input.skill.name}"`);
  const after = validated(withSkill(config, id, latest + 1, input.skill.overrides));
  draftRow(
    ctx,
    input.orgId,
    id,
    latest + 1,
    input.skill,
    await sha256(input.skill.body),
    "current",
    {
      source: "app",
      note: input.note ?? null,
      ...(createdBy ? { createdBy } : {}),
      parent: latest || null,
    },
  );
  return writeOrgVersion(ctx, input.orgId, version, after, {
    source: "app",
    before: config,
    note: input.note || `${latest ? "Changed" : "Added"} the skill ${input.skill.name}`,
    ...(createdBy ? { createdBy } : {}),
  });
}

/** The slugs of the org's other skills and the built-ins: names are unique in the org. */
async function currentNames(db: Db, org: string, config: OrgConfig, except: string) {
  const others = Object.entries(config.skills)
    .filter(([id]) => id !== except)
    .map(([id, s]) => ({ id, version: s.version }));
  const rows = await versionsOf(db, org, others);
  return new Set([
    ...[...rows.values()].map((r) => skillSlug(r.name)),
    ...BUILTIN_SKILLS.map((s) => s.slug),
  ]);
}

const target = z.union([
  z.object({ agent: z.string().trim().min(1).max(60) }).strict(),
  z
    .object({
      workflowId: z.string().min(1).max(64),
      stageId: z.string().min(1).max(40),
      when: skillConditionSchema.optional(),
    })
    .strict(),
]);
type Target = z.infer<typeof target>;
type AttachInput = {
  orgId: string;
  baseVersion: number;
  skillId: string;
  target: Target;
  note?: string | undefined;
};

/** The config with the skill attached to (or, `remove`, detached from) the target. */
function attached(config: OrgConfig, skill: string, t: Target, remove: boolean): OrgConfig {
  if ("agent" in t) {
    const key = t.agent.toLowerCase();
    const was = config.agentSkills[key] ?? [];
    const now = remove ? was.filter((x) => x !== skill) : [...new Set([...was, skill])];
    const agentSkills = { ...config.agentSkills, [key]: now };
    if (now.length === 0) delete agentSkills[key];
    return { ...config, agentSkills };
  }
  const edit = <W extends { id: string; stages: OrgConfig["workflows"][number]["stages"] }>(
    w: W,
  ) =>
    w.id !== t.workflowId
      ? w
      : {
          ...w,
          stages: w.stages.map((s) => {
            if (s.id !== t.stageId) return s;
            const rest = (s.skills ?? []).filter((a) => a.skill !== skill);
            const skills = remove
              ? rest
              : [...rest, { skill, ...(t.when ? { when: t.when } : {}) }];
            const { skills: _drop, ...bare } = s;
            return skills.length ? { ...bare, skills } : bare;
          }),
        };
  const builtIns: OrgConfig["builtIns"] = {};
  for (const [k, w] of Object.entries(config.builtIns))
    if (w) builtIns[k as keyof OrgConfig["builtIns"]] = edit(w);
  return { ...config, workflows: config.workflows.map(edit), builtIns };
}

function requireTarget(config: OrgConfig, t: Target) {
  if ("agent" in t) {
    if (!config.agents.some((a) => a.name.toLowerCase() === t.agent.toLowerCase()))
      throw new OperationError("not_found", `the org has no agent ${t.agent}`);
    return;
  }
  const w = [...config.workflows, ...Object.values(config.builtIns)].find(
    (x) => x?.id === t.workflowId,
  );
  if (!w?.stages.some((s) => s.id === t.stageId))
    throw new OperationError("not_found", `no stage ${t.stageId} in ${t.workflowId}`);
}

async function attachSkill(ctx: HandlerContext, input: AttachInput, createdBy?: string) {
  return changeAttachment(ctx, input, false, createdBy);
}
async function detachSkill(ctx: HandlerContext, input: AttachInput, createdBy?: string) {
  return changeAttachment(ctx, input, true, createdBy);
}
async function changeAttachment(
  ctx: HandlerContext,
  input: AttachInput,
  remove: boolean,
  createdBy?: string,
) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  requireTarget(config, input.target);
  const after = validated(attached(config, input.skillId, input.target, remove));
  const where = "agent" in input.target ? input.target.agent : input.target.stageId;
  return writeOrgVersion(ctx, input.orgId, version, after, {
    source: "app",
    before: config,
    note:
      input.note ||
      `${remove ? "Detached" : "Attached"} ${input.skillId} ${remove ? "from" : "to"} ${where}`,
    ...(createdBy ? { createdBy } : {}),
  });
}

type ArchiveInput = { orgId: string; baseVersion: number; skillId: string; note?: string };
async function archiveSkill(ctx: HandlerContext, input: ArchiveInput, createdBy?: string) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  if (!config.skills[input.skillId])
    throw new OperationError("not_found", `the org has no skill ${input.skillId}`);
  const used = attachments(config, input.skillId);
  if (used.length)
    throw new OperationError(
      "invalid_input",
      `${input.skillId} is still attached (${used.join(", ")}): detach it first`,
    );
  const { [input.skillId]: _gone, ...skills } = config.skills;
  return writeOrgVersion(ctx, input.orgId, version, validated({ ...config, skills }), {
    source: "app",
    before: config,
    note: input.note || `Archived the skill ${input.skillId}`,
    ...(createdBy ? { createdBy } : {}),
  });
}

type AcceptInput = {
  orgId: string;
  baseVersion: number;
  skillId: string;
  version: number;
  sha256: string;
  note?: string;
};
async function acceptSkill(ctx: HandlerContext, input: AcceptInput, createdBy?: string) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  const row = await ctx.db
    .selectFrom("core_skill_versions")
    .select(["status", "overrides", "name", "parent_version", "sha256"])
    .where("org_id", "=", input.orgId)
    .where("skill_id", "=", input.skillId)
    .where("version", "=", input.version)
    .executeTakeFirst();
  if (!row || row.status !== "proposed")
    throw new OperationError("not_found", "no such proposal waiting for a decision");
  if (row.sha256 !== input.sha256)
    throw new OperationError(
      "conflict",
      "the proposal's text isn't the text you read: read it again (skill.get with its version) before accepting",
    );
  // A proposal made against an older version would quietly replace a later save (review of #155).
  if ((row.parent_version ?? null) !== (config.skills[input.skillId]?.version ?? null))
    throw new OperationError(
      "conflict",
      `this proposal was made against v${row.parent_version ?? "none"}; the skill is at v${config.skills[input.skillId]?.version ?? "none"} now: propose again`,
    );
  if ((await currentNames(ctx.db, input.orgId, config, input.skillId)).has(skillSlug(row.name)))
    throw new OperationError("invalid_input", `another skill is called "${row.name}"`);
  const overrides = row.overrides
    ? (JSON.parse(row.overrides) as SkillDraft["overrides"])
    : undefined;
  const after = validated(withSkill(config, input.skillId, input.version, overrides));
  ctx.write(
    ctx.db
      .updateTable("core_skill_versions")
      .set({ status: "current" })
      .where("org_id", "=", input.orgId)
      .where("skill_id", "=", input.skillId)
      .where("version", "=", input.version)
      .where("status", "=", "proposed"),
  );
  return writeOrgVersion(ctx, input.orgId, version, after, {
    source: "app",
    before: config,
    note: input.note || `Accepted the proposed ${row.name} (v${input.version})`,
    ...(createdBy ? { createdBy } : {}),
  });
}

SKILL_WRITES["skill.save"] = saveSkill as unknown as SkillWrite;
SKILL_WRITES["skill.attach"] = attachSkill as unknown as SkillWrite;
SKILL_WRITES["skill.detach"] = detachSkill as unknown as SkillWrite;
SKILL_WRITES["skill.archive"] = archiveSkill as unknown as SkillWrite;
SKILL_WRITES["skill.accept"] = acceptSkill as unknown as SkillWrite;

// ---- Operations ----

const skillView = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  version: z.number(),
  builtin: z.boolean(),
  protected: z.boolean(),
  overrides: z.object({ builtin: z.string(), mode: z.string() }).nullable(),
  attachedTo: z.array(z.string()),
});

export const skillList = defineOperation({
  name: "skill.list",
  description:
    "The org's skills (ADR 0513): each one's current version, where it is attached, the stage types' built-in skills, and the proposals waiting for a person. Members only.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId }),
  output: z.object({
    orgConfigVersion: z.number(),
    skills: z.array(skillView),
    proposals: z.array(
      z.object({
        skillId: z.string(),
        version: z.number(),
        name: z.string(),
        createdBy: z.string().nullable(),
        note: z.string().nullable(),
        createdAt: z.string(),
        overrides: z.object({ builtin: z.string(), mode: z.string() }).nullable(),
        attachedTo: z.array(z.string()),
      }),
    ),
  }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const rows = await versionsOf(
      ctx.db,
      input.orgId,
      Object.entries(config.skills).map(([id, s]) => ({ id, version: s.version })),
    );
    // core_skill_versions_status_idx: the org's open proposals.
    const proposals = await ctx.db
      .selectFrom("core_skill_versions")
      .select(["skill_id", "version", "name", "created_by", "note", "created_at", "overrides"])
      .where("org_id", "=", input.orgId)
      .where("status", "=", "proposed")
      .limit(50)
      .execute();
    return {
      orgConfigVersion: version,
      skills: [
        ...[...rows.values()].map((r) => ({
          id: r.id,
          name: r.name,
          slug: skillSlug(r.name),
          description: r.description,
          version: r.version,
          builtin: false,
          protected: !!(r.overrides && BUILTIN_BY_ID.get(r.overrides.builtin)?.protected),
          overrides: r.overrides,
          attachedTo: attachments(config, r.id),
        })),
        ...BUILTIN_SKILLS.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          description: s.description,
          version: 0,
          builtin: true,
          protected: s.protected,
          overrides: null,
          attachedTo: [`the ${stageType(s.type)?.name ?? s.type} stage type`],
        })),
      ],
      proposals: proposals.map((p) => ({
        skillId: p.skill_id,
        version: p.version,
        name: p.name,
        createdBy: p.created_by,
        note: p.note,
        createdAt: p.created_at,
        // What accepting it would change: the built-in it extends or replaces, and every place the
        // skill is attached now (review of #155).
        overrides: p.overrides
          ? (JSON.parse(p.overrides) as { builtin: string; mode: string })
          : null,
        attachedTo: attachments(config, p.skill_id),
      })),
    };
  },
});

/** A line diff (LCS), for a person to read a proposal against the current text. */
export function lineDiff(
  before: string,
  after: string,
): { op: "same" | "add" | "remove"; line: string }[] {
  const a = before ? before.split("\n") : [];
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] ?? 0) + 1
          : Math.max((lcs[i + 1] as number[])[j] ?? 0, (lcs[i] as number[])[j + 1] ?? 0);
  const out: { op: "same" | "add" | "remove"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: "same", line: a[i] as string });
      i++;
      j++;
    } else if (
      i < n &&
      (j >= m || ((lcs[i + 1] as number[])[j] ?? 0) >= ((lcs[i] as number[])[j + 1] ?? 0))
    ) {
      out.push({ op: "remove", line: a[i] as string });
      i++;
    } else {
      out.push({ op: "add", line: b[j] as string });
      j++;
    }
  }
  return out;
}

export const skillGet = defineOperation({
  name: "skill.get",
  description:
    "One skill (ADR 0513): its current text, its versions (newest first, at most 50) with who wrote each and why, and where it is attached. With `version`, that version too (a proposal a person is about to accept): its text, its sha256 (which `skill.accept` must carry) and a line diff against the current text. Members only.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({
    orgId,
    skillId: z.string().min(1).max(80),
    version: z.number().int().positive().optional(),
  }),
  output: z.object({
    id: z.string(),
    /** The version asked for (a proposal to read before accepting it), with its diff. */
    version: z
      .object({
        version: z.number(),
        status: z.string(),
        name: z.string(),
        description: z.string(),
        body: z.string(),
        sha256: z.string(),
        overrides: z.object({ builtin: z.string(), mode: z.string() }).nullable(),
        diff: z.array(z.object({ op: z.enum(["same", "add", "remove"]), line: z.string() })),
      })
      .nullable(),
    current: z
      .object({ version: z.number(), name: z.string(), description: z.string(), body: z.string() })
      .nullable(),
    versions: z.array(
      z.object({
        version: z.number(),
        status: z.string(),
        source: z.string(),
        createdBy: z.string().nullable(),
        note: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    attachedTo: z.array(z.string()),
  }),
  async handler(input, ctx) {
    const builtin = BUILTIN_BY_ID.get(input.skillId);
    const { config } = await currentOrgConfig(ctx.db, input.orgId);
    if (builtin)
      return {
        id: builtin.id,
        current: {
          version: 0,
          name: builtin.name,
          description: builtin.description,
          body: builtin.body,
        },
        versions: [],
        attachedTo: attachments(config, builtin.id),
        version: null,
      };
    // By the primary key's prefix, newest first.
    const versions = await ctx.db
      .selectFrom("core_skill_versions")
      .select(["version", "status", "source", "created_by", "note", "created_at"])
      .where("org_id", "=", input.orgId)
      .where("skill_id", "=", input.skillId)
      .orderBy("version", "desc")
      .limit(50)
      .execute();
    const at = config.skills[input.skillId];
    const current = at
      ? (await versionsOf(ctx.db, input.orgId, [{ id: input.skillId, version: at.version }])).get(
          input.skillId,
        )
      : undefined;
    if (!versions.length) throw new OperationError("not_found", `no skill ${input.skillId}`);
    const asked = input.version
      ? (
          await versionsOf(ctx.db, input.orgId, [{ id: input.skillId, version: input.version }])
        ).get(input.skillId)
      : undefined;
    if (input.version && !asked)
      throw new OperationError("not_found", `no v${input.version} of ${input.skillId}`);
    return {
      id: input.skillId,
      version: asked
        ? {
            version: asked.version,
            status: asked.status,
            name: asked.name,
            description: asked.description,
            body: asked.body,
            sha256: asked.sha256,
            overrides: asked.overrides,
            diff: lineDiff(current?.body ?? "", asked.body),
          }
        : null,
      current: current
        ? {
            version: current.version,
            name: current.name,
            description: current.description,
            body: current.body,
          }
        : null,
      versions: versions.map((v) => ({
        version: v.version,
        status: v.status,
        source: v.source,
        createdBy: v.created_by,
        note: v.note,
        createdAt: v.created_at,
      })),
      attachedTo: attachments(config, input.skillId),
    };
  },
});

export const skillSave = defineOperation({
  name: "skill.save",
  description:
    "Write a skill (ADR 0513): a new skill, or a new version of one by id, with its name, when to use it, its instructions, and the built-in skill it extends or replaces. It applies at once, as a new org config version. A skill a judge follows (attached to a stage that judges the work or to a judging agent, or extending the reviewer's built-in skill) is policy: the save waits for an org admin. A protected built-in can't be replaced. Org admins only.",
  risk: "write",
  riskOf: async (input, at) => {
    const id = input.skillId ?? "sk_new";
    return riskOfSave(at.db, input.orgId, input.baseVersion, (c) =>
      withSkill(c, id, (c.skills[id]?.version ?? 0) + 1, input.skill.overrides),
    );
  },
  actors: ["human"],
  permission: "admin",
  // Config is a decision made in the app (ADR 0340): never from the CLI, MCP or a device token.
  browserOnly: true,
  input: z.object({
    orgId,
    baseVersion,
    skillId: skillIdSchema.optional(),
    skill: skillDraftSchema,
    note,
  }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return saveSkill(ctx, input);
  },
});

const attachInput = z.object({
  orgId,
  baseVersion,
  skillId: z.string().min(1).max(80),
  target,
  note,
});

export const skillAttach = defineOperation({
  name: "skill.attach",
  description:
    "Attach a skill (ADR 0513) to an org agent (always loaded) or to a stage of an org workflow, optionally under a condition (paths the change touches, a size, a domain). Practice, except on a stage that judges the work or a judging agent: then it waits for an org admin. Org admins only.",
  risk: "write",
  riskOf: (input, at) =>
    riskOfSave(at.db, input.orgId, input.baseVersion, (c) =>
      attached(c, input.skillId, input.target, false),
    ),
  actors: ["human"],
  permission: "admin",
  // Config is a decision made in the app (ADR 0340): never from the CLI, MCP or a device token.
  browserOnly: true,
  input: attachInput,
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return attachSkill(ctx, input);
  },
});

export const skillDetach = defineOperation({
  name: "skill.detach",
  description:
    "Detach a skill from an org agent or a workflow stage (ADR 0513). Removing one a judge follows is a loosening: it waits for an org admin. Org admins only.",
  risk: "write",
  riskOf: (input, at) =>
    riskOfSave(at.db, input.orgId, input.baseVersion, (c) =>
      attached(c, input.skillId, input.target, true),
    ),
  actors: ["human"],
  permission: "admin",
  // Config is a decision made in the app (ADR 0340): never from the CLI, MCP or a device token.
  browserOnly: true,
  input: attachInput,
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return detachSkill(ctx, input);
  },
});

export const skillArchive = defineOperation({
  name: "skill.archive",
  description:
    "Archive a skill no agent or stage uses any more (ADR 0513): it leaves the org's current config; its versions stay for items pinned to older ones. Refused while it is attached. Org admins only.",
  risk: "write",
  riskOf: (input, at) =>
    riskOfSave(at.db, input.orgId, input.baseVersion, (c) => {
      const { [input.skillId]: _gone, ...skills } = c.skills;
      return { ...c, skills };
    }),
  actors: ["human"],
  permission: "admin",
  // Config is a decision made in the app (ADR 0340): never from the CLI, MCP or a device token.
  browserOnly: true,
  input: z.object({ orgId, baseVersion, skillId: skillIdSchema, note }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return archiveSkill(ctx, input);
  },
});

export const skillPropose = defineOperation({
  name: "skill.propose",
  description:
    "Propose a skill edit or a new skill (ADR 0513): a candidate version with its evidence (the incident or item it came from). It changes nothing: the org's admins see it in their inbox, and only a person accepts it (`skill.accept`). The improver's, an agent's or an autopilot's.",
  risk: "write",
  actors: ["self-improve", "agent"],
  permission: "signed-in",
  // The project whose work the evidence comes from: its autonomy policy decides the call.
  input: z.object({ projectId, skillId: skillIdSchema.optional(), skill: skillDraftSchema, note }),
  output: z.object({ skillId: z.string(), version: z.number() }),
  async handler(raw, ctx) {
    const input = { ...raw, orgId: requireProject(ctx).org_id };
    const { config } = await currentOrgConfig(ctx.db, input.orgId);
    if (input.skillId && !config.skills[input.skillId])
      throw new OperationError("not_found", `the org has no skill ${input.skillId}`);
    const id = input.skillId ?? newSkillId();
    const latest = await latestVersion(ctx.db, input.orgId, id);
    if (latest >= MAX_SKILL_VERSIONS)
      throw new OperationError(
        "invalid_input",
        `a skill keeps at most ${MAX_SKILL_VERSIONS} versions`,
      );
    // Bounded (review of #155): open proposals per org, and per proposer a day
    // (core_skill_versions_status_idx, at most MAX_OPEN_PROPOSALS + 1 rows).
    const open = await ctx.db
      .selectFrom("core_skill_versions")
      .select(["created_by", "created_at"])
      .where("org_id", "=", input.orgId)
      .where("status", "=", "proposed")
      .limit(MAX_OPEN_PROPOSALS + 1)
      .execute();
    if (open.length >= MAX_OPEN_PROPOSALS)
      throw new OperationError(
        "conflict",
        `${open.length} proposals are waiting for a person: decide some first`,
      );
    // Every proposal this proposer made today, whatever became of it (core_skill_versions_author_idx).
    const today = await ctx.db
      .selectFrom("core_skill_versions")
      .select("version")
      .where("org_id", "=", input.orgId)
      .where("created_by", "=", ctx.actor.id)
      .where("created_at", ">=", `${ctx.now.slice(0, 10)}T00:00:00.000Z`)
      .limit(MAX_PROPOSALS_A_DAY + 1)
      .execute();
    if (today.length >= MAX_PROPOSALS_A_DAY)
      throw new OperationError("conflict", `at most ${MAX_PROPOSALS_A_DAY} proposals a day`);
    // Its evidence names an item of this project (review of #155).
    const from = input.skill.provenance?.workItemId;
    if (from) {
      const item = await ctx.db
        .selectFrom("core_work_items")
        .select("project_id")
        .where("id", "=", from)
        .executeTakeFirst();
      if (item?.project_id !== requireProject(ctx).id)
        throw new OperationError(
          "invalid_input",
          "the provenance names an item of another project",
        );
    }
    if ((await currentNames(ctx.db, input.orgId, config, id)).has(skillSlug(input.skill.name)))
      throw new OperationError("invalid_input", `another skill is called "${input.skill.name}"`);
    // Rejected proposals go after 30 days, a few at a time (by the primary key's prefix).
    ctx.write(
      ctx.d1
        .prepare(
          `DELETE FROM core_skill_versions WHERE (org_id, skill_id, version) IN (
             SELECT org_id, skill_id, version FROM core_skill_versions INDEXED BY core_skill_versions_rejected_idx
             WHERE org_id = ? AND status = 'rejected' AND created_at < ? ORDER BY created_at LIMIT 20)`,
        )
        .bind(input.orgId, new Date(Date.parse(ctx.now) - 30 * 86_400_000).toISOString()),
    );
    draftRow(
      ctx,
      input.orgId,
      id,
      latest + 1,
      input.skill,
      await sha256(input.skill.body),
      "proposed",
      {
        source: ctx.actor.type,
        note: input.note ?? null,
        parent: config.skills[id]?.version ?? null,
      },
    );
    // One notice while proposals wait, not one each: only the first open proposal tells the admins.
    const admins =
      open.length > 0
        ? []
        : await ctx.db
            .selectFrom("core_member")
            .select("user_id")
            .where("organization_id", "=", input.orgId)
            .where("role", "in", ["owner", "admin"])
            .limit(10)
            .execute();
    for (const a of admins)
      ctx.emit({
        kind: "notify",
        payload: {
          event: "skill.proposed",
          userId: a.user_id,
          workItemId: input.skill.provenance?.workItemId ?? null,
          title: `Proposed skill change: ${input.skill.name}${input.note ? ` (${input.note})` : ""}`,
          url: "/settings",
        },
      });
    return { skillId: id, version: latest + 1 };
  },
});

export const skillAccept = defineOperation({
  name: "skill.accept",
  description:
    "Accept a proposed skill version (ADR 0513): it becomes the skill's current version in a new org config version. Carry the `sha256` of the text you read (`skill.get` with the version): a mismatch is refused, so nobody accepts text they didn't see. A person's decision, in the app; one a judge follows is policy and waits for an org admin. Org admins only.",
  risk: "write",
  // Judged by the proposal being accepted: its own overrides (review of #155), so a proposal that
  // extends the reviewer's protected skill is the loosening it is.
  riskOf: async (input, at) => {
    const row = await at.db
      .selectFrom("core_skill_versions")
      .select("overrides")
      .where("org_id", "=", input.orgId)
      .where("skill_id", "=", input.skillId)
      .where("version", "=", input.version)
      .executeTakeFirst();
    const overrides = row?.overrides
      ? (JSON.parse(row.overrides) as SkillDraft["overrides"])
      : undefined;
    return riskOfSave(at.db, input.orgId, input.baseVersion, (c) =>
      withSkill(c, input.skillId, input.version, overrides),
    );
  },
  actors: ["human"],
  permission: "admin",
  // Config is a decision made in the app (ADR 0340): never from the CLI, MCP or a device token.
  browserOnly: true,
  input: z.object({
    orgId,
    baseVersion,
    skillId: skillIdSchema,
    version: z.number().int().positive(),
    /** The sha256 of the text the person read (`skill.get`): what they accept, exactly. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    note,
  }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return acceptSkill(ctx, input);
  },
});

export const skillReject = defineOperation({
  name: "skill.reject",
  description:
    "Turn down a proposed skill version (ADR 0513); it stays in the history, marked rejected. Org admins only.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  // Config is a decision made in the app (ADR 0340): never from the CLI, MCP or a device token.
  browserOnly: true,
  input: z.object({ orgId, skillId: skillIdSchema, version: z.number().int().positive(), note }),
  output: z.object({ rejected: z.boolean() }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .updateTable("core_skill_versions")
        .set({ status: "rejected", note: input.note ?? null })
        .where("org_id", "=", input.orgId)
        .where("skill_id", "=", input.skillId)
        .where("version", "=", input.version)
        .where("status", "=", "proposed"),
    );
    ctx.guardChanged("a proposal waiting for a decision");
    ctx.change({
      entity: "skill",
      id: input.skillId,
      after: { version: input.version, status: "rejected" },
    });
    return { rejected: true };
  },
});

// ---- Jobs ----

/**
 * The stage instance a job runs for, by the stage's type and the job's role, never by id alone
 * (review of #155: a custom stage called "verify" isn't the reviewer's). Null for the spec critic
 * and the adjudicator, which judge and get no org skills.
 */
function jobStage(
  def: WorkflowDefinition,
  stage: string,
  context: Record<string, unknown>,
): StageInstance | null {
  if (context.specId !== undefined || context.adjudicate !== undefined) return null;
  const step = (context.step as { id?: unknown } | undefined)?.id;
  if (typeof step === "string")
    return def.stages.find((s) => stageType(s.type)?.small && slotStepId(s.id) === step) ?? null;
  const type =
    stage === "triage"
      ? "triage"
      : stage === "planning" || stage === "spec"
        ? "interview-planning"
        : stage === "build"
          ? "build"
          : stage === "verify"
            ? "checks"
            : null;
  return type ? (def.stages.find((s) => s.type === type) ?? null) : null;
}

/**
 * The skills a job follows (spec 52, "How a run's skills are resolved"), as references for its
 * context, at the org config version the item pinned (an item with none gets none: a skill edit
 * never reaches work it wasn't pinned for). A job that judges the work (the reviewer, an agent
 * check, triage, which ties criteria to checks) gets only its built-ins and the skills an org admin
 * approved for that judge (their attachment was a loosening); the spec critic and the adjudicator
 * get none. Reads only the skills it needs, without their bodies.
 */
export async function jobSkills(
  ctx: HandlerContext,
  w: WorkItemRow,
  raw: ProjectPolicy | null,
  stage: string,
  context: Record<string, unknown>,
): Promise<ResolvedSkill[]> {
  if (!raw || !onOrgWorkflow(raw) || w.org_config_version === null) return [];
  const org = await storedOrgConfig(ctx.db, w.org_id, w.org_config_version);
  if (!org) return [];
  const def = resolveProjectWorkflow(raw, org);
  if (!def?.ok) return [];
  const inst = jobStage(def.value, stage, context);
  if (!inst) return [];
  const type = stageType(inst.type);
  const judging = !!type?.judges || inst.type === "triage";
  // A judge's own attachments were approved as loosenings; triage's aren't (its type doesn't judge
  // by policy yet), so it takes none. Others take what's attached.
  const stageSkills = judging && !type?.judges ? [] : (inst.skills ?? []);
  const agentSkills =
    inst.agent && (!judging || type?.judges === "agent")
      ? (org.agentSkills[inst.agent.toLowerCase()] ?? [])
      : [];
  const builtins = new Set(BUILTIN_SKILLS.filter((b) => b.type === inst.type).map((b) => b.id));
  const overriding = Object.entries(org.skills)
    .filter(([, s]) => s.overrides && builtins.has(s.overrides.builtin))
    // A judge's built-in may only be extended where it is protected (an org admin approved that).
    .filter(([, s]) => !judging || !!BUILTIN_BY_ID.get(s.overrides?.builtin ?? "")?.protected)
    .map(([id]) => id);
  const needed = [...new Set([...overriding, ...agentSkills, ...stageSkills.map((a) => a.skill)])]
    .filter((id) => org.skills[id])
    .map((id) => ({ id, version: org.skills[id]?.version ?? 0 }));
  const rows = await versionsOf(ctx.db, w.org_id, needed, false);
  let domains: string[] = [];
  try {
    domains = w.domains ? (JSON.parse(w.domains) as string[]) : [];
  } catch {
    domains = [];
  }
  return resolveSkills({
    stageType: inst.type,
    orgSkills: rows,
    agentSkills,
    stageSkills,
    facts: { size: (w.size as Size | null) ?? null, domains, paths: null },
  });
}

export const skillForJob = defineOperation({
  name: "skill.forJob",
  description:
    "A skill's instructions for the runner of a job that follows it (ADR 0513): by the slug in the job's `skills`, at the version the job names. The runner's own active job only, fenced by its lease.",
  risk: "read",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({ workItemId, jobId, fencingToken, slug: z.string().min(1).max(60) }),
  output: z.object({
    slug: z.string(),
    version: z.number(),
    body: z.string(),
    sha256: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const job = await ctx.db
      .selectFrom("core_jobs as j")
      .innerJoin("core_runs as r", "r.job_id", "j.id")
      .innerJoin("core_leases as l", "l.work_item_id", "j.work_item_id")
      .select(["j.context", "j.org_id", "r.runner_id", "r.status", "l.fencing_token"])
      .where("j.id", "=", input.jobId)
      .where("j.work_item_id", "=", input.workItemId)
      .executeTakeFirst();
    if (
      !job ||
      job.runner_id !== ctx.actor.id ||
      !["claimed", "preparing", "running", "collecting"].includes(job.status)
    )
      throw new OperationError("not_found", "no such skill on your job");
    if (job.fencing_token !== input.fencingToken)
      throw new OperationError("fenced", `stale fencing token ${input.fencingToken}`);
    const refs = ((JSON.parse(job.context) as { skills?: ResolvedSkill[] }).skills ?? []).filter(
      (s) => s.slug === input.slug,
    );
    const ref = refs[0];
    if (!ref) throw new OperationError("not_found", "no such skill on your job");
    const builtin = BUILTIN_BY_ID.get(ref.id);
    if (builtin) return { slug: ref.slug, version: 0, body: builtin.body, sha256: null };
    const row = (await versionsOf(ctx.db, job.org_id, [{ id: ref.id, version: ref.version }])).get(
      ref.id,
    );
    // Only an accepted version, exactly the one the job names (review of #155).
    if (!row || row.status !== "current" || row.version !== ref.version)
      throw new OperationError("not_found", "no such skill on your job");
    return { slug: ref.slug, version: row.version, body: row.body, sha256: row.sha256 };
  },
});
