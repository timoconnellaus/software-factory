// Org workflows as versioned config (spec 52 PR (b), ADR 0510). An org's workflows and agents live
// in `core_org_configs` versions, written only through these operations with ADR 0370's machinery:
// validate first, a stale base is a conflict, and a save that loosens is `self-modify`, which an
// org admin approves (Q6). Built-in workflows (Attached PR, Incident) are visible and may only be
// tightened (Q10). Projects name an org workflow by id (PR (d)): a change that would leave one
// unable to run (archiving its workflow, a save today's engine can't run) is refused, naming them.
import type { Db } from "@software-factory/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { type ImpactChange, type PolicyImpact, same } from "../policy/impact.ts";
import {
  agentSchema,
  onOrgWorkflow,
  type ProjectPolicy,
  parseProjectPolicy,
} from "../policy/project-policy.ts";
import { BUILTIN_BY_ID } from "../skills/builtin.ts";
import { BUILT_IN_WORKFLOWS, WORKFLOW_TEMPLATES } from "../stages/builtins.ts";
import { summarise, workflowImpact } from "../stages/impact.ts";
import {
  BRINGS,
  type BuiltInKind,
  baselineFor,
  builtIn,
  builtInKind,
  EMPTY_ORG_CONFIG,
  MAX_ARCHIVED,
  type OrgConfig,
  orgConfigErrorText,
  orgConfigRaw,
  parseOrgConfig,
} from "../stages/org-config.ts";
import {
  normaliseOverrides,
  orgValueOf,
  resolveProjectWorkflow,
} from "../stages/project-workflow.ts";
import { STAGE_TYPES, stageType } from "../stages/registry.ts";
import { validateWorkflow } from "../stages/validate.ts";
import { type WorkflowDefinition, workflowDefinitionSchema } from "../stages/workflow.ts";

/** How many of an org's admins one org config write notifies, and how many overrides it names. */
export const NOTIFY_ADMINS = 10;
export const NOTIFY_ITEMS = 10;
const listed = (items: string[]) =>
  items.length <= NOTIFY_ITEMS
    ? items.join("; ")
    : `${items.slice(0, NOTIFY_ITEMS).join("; ")}; and ${items.length - NOTIFY_ITEMS} more`;

/** The org config operations whose loosening calls wait for an org admin. */
export const ORG_CONFIG_WRITES = [
  "workflow.save",
  "orgConfig.rollback",
  "agent.save",
  // Skills (ADR 0513): through the org config version and its impact check.
  "skill.save",
  "skill.attach",
  "skill.detach",
  "skill.archive",
  "skill.accept",
] as const;

const orgId = z.string().min(1);
const baseVersion = z.number().int().nonnegative();
const note = z.string().trim().max(500).optional();

const impactView = z.object({
  class: z.enum(["loosens", "tightens", "neutral"]),
  changes: z.array(
    z.object({
      path: z.string(),
      class: z.enum(["loosens", "tightens", "neutral"]),
      summary: z.string(),
    }),
  ),
});

const errorView = z.object({
  rule: z.string(),
  workflowId: z.string().nullable(),
  stageId: z.string().nullable(),
  message: z.string(),
});

const definitionView = z.record(z.string(), z.unknown());

/** The org's current config and its version (0 and the empty document before the first save). */
export async function currentOrgConfig(
  db: Db,
  org: string,
): Promise<{ version: number; config: OrgConfig }> {
  const row = await db
    .selectFrom("core_organization as o")
    .leftJoin("core_org_configs as c", (j) =>
      j.onRef("c.org_id", "=", "o.id").onRef("c.version", "=", "o.config_version"),
    )
    .select(["o.config_version", "c.raw"])
    .where("o.id", "=", org)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "no such org");
  if (!row.config_version || !row.raw) return { version: 0, config: EMPTY_ORG_CONFIG };
  const parsed = parseOrgConfig(JSON.parse(row.raw));
  // Only valid documents are written, so this is a code change that broke an old document: fail
  // closed rather than show or extend it.
  if (!parsed.ok) {
    throw new OperationError(
      "invalid_input",
      `the org config v${row.config_version} no longer validates: ${orgConfigErrorText(parsed.errors)}`,
    );
  }
  return { version: row.config_version, config: parsed.config };
}

export async function storedOrgConfig(
  db: Db,
  org: string,
  version: number,
): Promise<OrgConfig | null> {
  const row = await db
    .selectFrom("core_org_configs")
    .select("raw")
    .where("org_id", "=", org)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!row) return null;
  const parsed = parseOrgConfig(JSON.parse(row.raw));
  return parsed.ok ? parsed.config : null;
}

/**
 * How `after` changes `before`: each workflow and built-in by id. Agents are practice (neutral).
 * A workflow new to `after` is compared against its baseline (`baselineFor`): the last version
 * archived under its id, else the Software floor. Archiving is neutral: the archived version is kept.
 */
export function orgConfigImpact(before: OrgConfig, after: OrgConfig): PolicyImpact {
  const changes: ImpactChange[] = [];
  const now = new Set(after.workflows.map((w) => w.id));
  for (const w of after.workflows) {
    for (const c of workflowImpact(baselineFor(before, w.id), w).changes)
      changes.push({ ...c, path: `${w.id}.${c.path}` });
  }
  for (const w of before.workflows)
    if (!now.has(w.id))
      changes.push({ path: w.id, class: "neutral", summary: `Archives the workflow ${w.name}.` });
  for (const kind of Object.keys(BUILT_IN_WORKFLOWS) as BuiltInKind[]) {
    const b = builtIn(before, kind);
    for (const c of workflowImpact(b, builtIn(after, kind)).changes)
      changes.push({ ...c, path: `${b.id}.${c.path}` });
  }
  changes.push(...skillsImpact(before, after));
  // Agents are practice, except one that judges the work (an agent check's): a different prompt
  // there may pass what the old one sent back, so changing or removing it loosens (Q16).
  const judging = new Set([...judgingAgents(before), ...judgingAgents(after)]);
  const byName = (c: OrgConfig) => new Map(c.agents.map((a) => [a.name.toLowerCase(), a]));
  const was = byName(before);
  const now2 = byName(after);
  for (const name of new Set([...was.keys(), ...now2.keys()])) {
    if (JSON.stringify(was.get(name)) === JSON.stringify(now2.get(name))) continue;
    const label = now2.get(name)?.name ?? was.get(name)?.name ?? name;
    changes.push(
      judging.has(name)
        ? {
            path: `agents.${label}`,
            class: "loosens",
            summary: `${label} judges work in a workflow: changing it changes what passes.`,
          }
        : { path: `agents.${label}`, class: "neutral", summary: `The agent ${label} changed.` },
    );
  }
  return summarise(changes);
}

/**
 * Skills (ADR 0513): a version change, a new skill or a removed one is practice, except where a
 * judge follows it (Q16): attached to a stage that judges the work, to a judging agent, or extending
 * a protected built-in. Then it is policy: loosens, so a person decides.
 */
function skillsImpact(before: OrgConfig, after: OrgConfig): ImpactChange[] {
  const out: ImpactChange[] = [];
  const judged = new Set<string>();
  const judges = new Set([...judgingAgents(before), ...judgingAgents(after)]);
  for (const c of [before, after]) {
    for (const w of [...c.workflows, ...Object.values(c.builtIns)])
      for (const s of w?.stages ?? [])
        if (stageType(s.type)?.judges) for (const a of s.skills ?? []) judged.add(a.skill);
    for (const [agent, ids] of Object.entries(c.agentSkills))
      if (judges.has(agent.toLowerCase())) for (const id of ids) judged.add(id);
    for (const [id, s] of Object.entries(c.skills))
      if (s.overrides && BUILTIN_BY_ID.get(s.overrides.builtin)?.protected) judged.add(id);
  }
  for (const id of new Set([...Object.keys(before.skills), ...Object.keys(after.skills)])) {
    const was = before.skills[id];
    const now = after.skills[id];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    const what = !was ? "added" : !now ? "removed" : `v${was.version} → v${now.version}`;
    out.push(
      judged.has(id)
        ? {
            path: `skills.${id}`,
            class: "loosens",
            summary: `A skill a judge follows changed (${id}, ${what}).`,
          }
        : { path: `skills.${id}`, class: "neutral", summary: `The skill ${id}: ${what}.` },
    );
  }
  const agents = new Set([...Object.keys(before.agentSkills), ...Object.keys(after.agentSkills)]);
  for (const agent of agents) {
    const was = JSON.stringify(before.agentSkills[agent] ?? []);
    if (was === JSON.stringify(after.agentSkills[agent] ?? [])) continue;
    out.push(
      judges.has(agent.toLowerCase())
        ? {
            path: `agentSkills.${agent}`,
            class: "loosens",
            summary: `${agent} judges work: the skills it follows changed.`,
          }
        : { path: `agentSkills.${agent}`, class: "neutral", summary: `${agent}'s skills changed.` },
    );
  }
  return out;
}

/** The agents (lower-cased names) that judge work in any of the document's workflows. */
function judgingAgents(config: OrgConfig): string[] {
  const out: string[] = [];
  for (const w of [...config.workflows, ...Object.values(config.builtIns)])
    for (const s of w?.stages ?? [])
      if (s.agent && stageType(s.type)?.judges) out.push(s.agent.toLowerCase());
  return out;
}

export function requireBase(version: number, base: number) {
  if (version !== base) {
    throw new OperationError(
      "conflict",
      `the org config moved on: it's at v${version}, this was edited from v${base}. Reload and save again.`,
      { currentVersion: version },
    );
  }
}

export function validated(doc: unknown): OrgConfig {
  const parsed = parseOrgConfig(doc);
  if (!parsed.ok) {
    throw new OperationError(
      "invalid_input",
      `the workflow isn't valid: ${orgConfigErrorText(parsed.errors)}`,
      { errors: parsed.errors },
    );
  }
  return parsed.config;
}

/** The document with `workflow` saved in it: a built-in's copy, or an org workflow by id. */
export function withWorkflow(config: OrgConfig, workflow: WorkflowDefinition): OrgConfig {
  const kind = builtInKind(workflow.id);
  if (kind) return { ...config, builtIns: { ...config.builtIns, [kind]: workflow } };
  const exists = config.workflows.some((w) => w.id === workflow.id);
  return {
    ...config,
    // Re-added: it is current again, and was compared against its archived version.
    archived: config.archived.filter((w) => w.id !== workflow.id),
    workflows: exists
      ? config.workflows.map((w) => (w.id === workflow.id ? workflow : w))
      : [...config.workflows, workflow],
  };
}

/** The most projects an org config change checks; an org with more can't be checked, so fails closed. */
const MAX_ORG_PROJECTS = 500;

/**
 * The org's projects and their current config documents, to see which run which org workflow. An
 * org config change is a person's rare act, so this reads every project of the org (by the
 * `(org_id, slug)` unique index) and its current config row (by primary key).
 */
export async function orgProjects(
  db: Db,
  org: string,
): Promise<{ id: string; name: string; policy: ProjectPolicy | null }[]> {
  const rows = await db
    .selectFrom("core_projects as p")
    .leftJoin("core_project_policies as pp", (j) =>
      j.onRef("pp.project_id", "=", "p.id").onRef("pp.sha", "=", "p.policy_sha"),
    )
    .select(["p.id", "p.name", "pp.raw", "pp.valid"])
    .where("p.org_id", "=", org)
    .orderBy("p.slug")
    .limit(MAX_ORG_PROJECTS + 1)
    .execute();
  if (rows.length > MAX_ORG_PROJECTS)
    throw new OperationError(
      "conflict",
      `the org has more than ${MAX_ORG_PROJECTS} projects, so which use its workflows can't be checked`,
    );
  return rows.map((r) => {
    const parsed = r.valid && r.raw ? parseProjectPolicy(r.raw) : null;
    return { id: r.id, name: r.name, policy: parsed?.ok ? parsed.policy : null };
  });
}

/** The projects whose current config runs org workflow `id`. */
export function projectsOn(
  projects: { name: string; policy: ProjectPolicy | null }[],
  id: string,
): string[] {
  return projects
    .filter((p) => p.policy && onOrgWorkflow(p.policy) && p.policy.workflow === id)
    .map((p) => p.name);
}

/**
 * Why `config` would leave a project unable to run, or null: every project on an org workflow must
 * still resolve against it (the workflow exists, its overrides apply, and today's engine can run it).
 * Checked before an org version is written, not discovered when every item on it fails closed.
 */
export function strandedBy(
  projects: { name: string; policy: ProjectPolicy | null }[],
  config: OrgConfig,
  /** The version it replaces: a project that couldn't run on it either isn't this change's doing. */
  before: OrgConfig,
): string | null {
  const stranded: string[] = [];
  for (const p of projects) {
    if (!p.policy) continue;
    const resolved = resolveProjectWorkflow(p.policy, config);
    if (!resolved || resolved.ok) continue;
    const was = resolveProjectWorkflow(p.policy, before);
    if (was && !was.ok) continue;
    stranded.push(`${p.name} (${resolved.error})`);
  }
  return stranded.length
    ? `this would leave projects that use the workflow unable to run: ${stranded.join("; ")}`
    : null;
}

/**
 * Queues a new version and points the org at it. The batch aborts if the org moved past `expect`
 * in the meantime, so two saves can't both apply.
 */
export async function writeOrgVersion(
  ctx: HandlerContext,
  org: string,
  expect: number,
  config: OrgConfig,
  input: {
    source: "app" | "import" | "rollback" | "migrated";
    note: string | null;
    createdBy?: string;
    /** The version it replaces, to record how this one changed it (read by `orgConfig.get`). */
    before: OrgConfig;
  },
): Promise<{ version: number }> {
  const version = expect + 1;
  const projects = await orgProjects(ctx.db, org);
  const stranded = strandedBy(projects, config, input.before);
  if (stranded) throw new OperationError("invalid_input", stranded);
  // An org admin's approval of a project's looser override counts for one org version
  // (core_override_approvals). The factory carries it to this version where the org leaves that
  // setting's value as it was; where the org moved it and the override is still looser, it lapses:
  // the stricter applies, and the org's admins are told (spec 52, fourth review).
  const approvals =
    expect === 0
      ? []
      : await ctx.db
          .selectFrom("core_override_approvals")
          .selectAll()
          .where("org_id", "=", org)
          .where("org_version", "=", expect)
          .limit(500)
          .execute();
  const lapsed: string[] = [];
  for (const a of approvals) {
    const p = projects.find((x) => x.id === a.project_id);
    if (!p?.policy) continue;
    let approved: unknown;
    try {
      approved = JSON.parse(a.value);
    } catch {
      continue;
    }
    // Only for the override the project still has.
    if (!same(p.policy.workflowOverrides[a.stage_id]?.[a.setting], approved)) continue;
    const was = orgValueOf(p.policy, input.before, a.stage_id, a.setting);
    const now = orgValueOf(p.policy, config, a.stage_id, a.setting);
    if (!now.found) continue;
    if (was.found && same(was.value, now.value)) {
      ctx.write(
        ctx.db.insertInto("core_override_approvals").values({ ...a, org_version: version }),
      );
      continue;
    }
    const n = normaliseOverrides(p.policy, config);
    if (n.looser.some((l) => l.stageId === a.stage_id && l.key === a.setting))
      lapsed.push(`${p.name}: ${a.stage_id} ${a.setting}`);
  }
  // An override that was as strict as the org's value, or stricter, and that this version makes
  // looser has no approval: the stricter value applies until an org admin approves it or the
  // project drops it, and the org's admins are told so (spec 52, fifth review). In memory: the
  // projects are already read.
  const unapproved: string[] = [];
  for (const p of projects) {
    if (!p.policy || !onOrgWorkflow(p.policy)) continue;
    const was = normaliseOverrides(p.policy, input.before).looser;
    for (const l of normaliseOverrides(p.policy, config).looser)
      if (!was.some((x) => x.stageId === l.stageId && x.key === l.key))
        unapproved.push(`${p.name}: ${l.stageId} ${l.key}`);
  }
  if (lapsed.length || unapproved.length) {
    // Bounded (review of #128): at most NOTIFY_ADMINS admins, owners first, each told in at most two
    // messages naming at most NOTIFY_ITEMS overrides, however many projects one save (or one
    // adoption run) touches.
    const admins = await ctx.db
      .selectFrom("core_member")
      .select("user_id")
      .where("organization_id", "=", org)
      .where("role", "in", ["owner", "admin"])
      .orderBy(sql`role = 'owner'`, "desc")
      .orderBy("created_at")
      .limit(NOTIFY_ADMINS)
      .execute();
    for (const admin of admins) {
      if (lapsed.length)
        ctx.emit({
          kind: "notify",
          payload: {
            event: "workflow.overrideLapsed",
            userId: admin.user_id,
            title: `The org's workflow change ends approved project overrides (the stricter value applies): ${listed(lapsed)}`,
            url: "/settings",
          },
        });
      if (unapproved.length)
        ctx.emit({
          kind: "notify",
          payload: {
            event: "workflow.overrideNeedsApproval",
            userId: admin.user_id,
            title: `The org's workflow change makes project overrides looser than the org's values; each needs an org admin's approval or removal (the stricter value applies until then): ${listed(unapproved)}`,
            url: "/settings",
          },
        });
    }
  }
  ctx.guardExists(
    "org config base unchanged",
    ctx.db
      .selectFrom("core_organization")
      .select("id")
      .where("id", "=", org)
      .where((eb) =>
        expect === 0 ? eb("config_version", "is", null) : eb("config_version", "=", expect),
      ),
  );
  ctx.write(
    ctx.db.insertInto("core_org_configs").values({
      org_id: org,
      version,
      raw: orgConfigRaw(config),
      impact: orgConfigImpact(input.before, config).class,
      source: input.source,
      created_by: input.createdBy ?? ctx.actor.id,
      note: input.note,
      parent_version: expect === 0 ? null : expect,
      created_at: ctx.now,
    }),
  );
  ctx.write(
    ctx.db.updateTable("core_organization").set({ config_version: version }).where("id", "=", org),
  );
  ctx.change({
    entity: "org",
    id: org,
    before: { configVersion: expect },
    after: { configVersion: version, source: input.source },
  });
  return { version };
}

/**
 * `self-modify` when the call loosens the org's config; `write` when it doesn't, or when the handler
 * will refuse it anyway (a stale base, an invalid document). If working out the risk fails, the
 * save is `self-modify`: it fails closed, to a person (ADR 0516).
 */
export async function riskOfSave(
  db: Db,
  org: string,
  base: number,
  next: (c: OrgConfig) => OrgConfig,
): Promise<"write" | "self-modify"> {
  try {
    const { version, config } = await currentOrgConfig(db, org);
    if (version !== base) return "write";
    const after = parseOrgConfig(next(config));
    if (!after.ok) return "write";
    // A change that would strand a project is refused by the handler, not asked of an admin.
    if (strandedBy(await orgProjects(db, org), after.config, config)) return "write";
    return orgConfigImpact(config, after.config).class === "loosens" ? "self-modify" : "write";
  } catch {
    return "self-modify";
  }
}

const summaryView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** The item kind a built-in workflow runs for; null for the org's own. */
  builtIn: z.enum(["incident", "attached"]).nullable(),
  stages: z.array(
    z.object({ id: z.string(), name: z.string(), type: z.string(), phase: z.string() }),
  ),
});

const summary = (w: WorkflowDefinition, kind: BuiltInKind | null) => ({
  id: w.id,
  name: w.name,
  description: w.description,
  builtIn: kind,
  stages: w.stages.map((s) => ({ id: s.id, name: s.name, type: s.type, phase: s.phase })),
});

export const workflowList = defineOperation({
  name: "workflow.list",
  description:
    "The org's workflows (spec 52): its own, then the built-in ones (Attached PR, Incident) as the org runs them, each with its stages, and the templates an admin can copy. Projects don't run org workflows yet. Members only.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId }),
  output: z.object({
    version: z.number(),
    workflows: z.array(summaryView),
    templates: z.array(summaryView),
  }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    return {
      version,
      workflows: [
        ...config.workflows.map((w) => summary(w, null)),
        ...(Object.keys(BUILT_IN_WORKFLOWS) as BuiltInKind[]).map((k) =>
          summary(builtIn(config, k), k),
        ),
      ],
      templates: WORKFLOW_TEMPLATES.map((t) => summary(t, null)),
    };
  },
});

export const workflowGet = defineOperation({
  name: "workflow.get",
  description:
    "One org workflow by id, with every stage's settings (defaults filled). For a built-in workflow, also the shipped definition it may only tighten. Members only.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId, workflowId: z.string().min(1) }),
  output: z.object({
    version: z.number(),
    workflow: definitionView,
    builtIn: z.enum(["incident", "attached"]).nullable(),
    shipped: definitionView.nullable(),
  }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const kind = builtInKind(input.workflowId) ?? null;
    const workflow = kind
      ? builtIn(config, kind)
      : config.workflows.find((w) => w.id === input.workflowId);
    if (!workflow) throw new OperationError("not_found", `no workflow ${input.workflowId}`);
    return {
      version,
      workflow,
      builtIn: kind,
      shipped: kind ? BUILT_IN_WORKFLOWS[kind] : null,
    };
  },
});

export const workflowPreview = defineOperation({
  name: "workflow.preview",
  description:
    "Check a draft workflow without saving it: every broken rule (each with its stage and rule: S1–S3, F1–F9), and the impact against the saved one (each change loosens, tightens or is neutral). A loosening save waits for an org admin; a built-in workflow can only be tightened. Members only.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId, workflow: definitionView }),
  output: z.object({
    valid: z.boolean(),
    errors: z.array(errorView),
    impact: impactView.nullable(),
    currentVersion: z.number(),
  }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const draft = workflowDefinitionSchema.safeParse(input.workflow);
    const kind = draft.success ? builtInKind(draft.data.id) : undefined;
    const v = validateWorkflow(input.workflow, {
      agents: config.agents,
      ...(kind ? { brings: BRINGS[kind] } : {}),
    });
    if (!v.valid || !draft.success) {
      return {
        valid: false,
        errors: v.valid ? [] : v.errors.map((e) => ({ ...e, workflowId: null })),
        impact: null,
        currentVersion: version,
      };
    }
    const before = kind ? builtIn(config, kind) : baselineFor(config, v.definition.id);
    return {
      valid: true,
      errors: [],
      impact: workflowImpact(before, v.definition),
      currentVersion: version,
    };
  },
});

export const workflowSave = defineOperation({
  name: "workflow.save",
  description:
    "Save an org workflow (spec 52): a new org config version with this workflow added or replaced by id. Name the org config version you edited from (`baseVersion`; 0 before the first save): a stale base is a conflict. An invalid workflow is refused with every broken rule. A save that loosens (a gate or check removed or skipped, a decider broadened, a gate moved later…) is self-modify and waits for an org admin. A built-in workflow (Attached PR, Incident) can only be tightened: a loosening save of one is refused. Org admins only.",
  risk: "write",
  // A built-in copy looser than the shipped one doesn't parse (refused); one that undoes the org's
  // own tightening loosens against the org's version, so it waits for an org admin like any other.
  riskOf: (input, at) =>
    riskOfSave(at.db, input.orgId, input.baseVersion, (c) =>
      withWorkflow(c, input.workflow as WorkflowDefinition),
    ),
  actors: ["human"],
  permission: "admin",
  // Config is a person's decision (ADR 0340): never from the CLI, MCP or any other token an agent
  // session might hold.
  browserOnly: true,
  // Decidable on the desktop with a presence proof for this exact call (ADR 0610); never the phone,
  // and never a CLI, MCP, runner or agent token.
  presenceDecidable: true,
  presenceSurfaces: ["desktop"],
  input: z.object({ orgId, baseVersion, workflow: definitionView, note }),
  output: z.object({ version: z.number(), impact: impactView }),
  async handler(input, ctx) {
    return saveWorkflow(ctx, input);
  },
});

async function saveWorkflow(
  ctx: HandlerContext,
  input: { orgId: string; baseVersion: number; workflow: unknown; note?: string | undefined },
  createdBy?: string,
) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  const draft = workflowDefinitionSchema.safeParse(input.workflow);
  if (!draft.success) {
    const i = draft.error.issues[0];
    throw new OperationError(
      "invalid_input",
      `the workflow isn't valid: ${i?.path.join(".") || "workflow"}: ${i?.message ?? "invalid"}`,
    );
  }
  if (WORKFLOW_TEMPLATES.some((t) => t.id === draft.data.id)) {
    throw new OperationError(
      "invalid_input",
      "a template can't be saved over: copy it with workflow.createFromTemplate",
    );
  }
  const after = validated(withWorkflow(config, draft.data));
  const impact = orgConfigImpact(config, after);
  const written = await writeOrgVersion(ctx, input.orgId, version, after, {
    source: "app",
    before: config,
    note: input.note || null,
    ...(createdBy ? { createdBy } : {}),
  });
  return { ...written, impact };
}

export const workflowCreateFromTemplate = defineOperation({
  name: "workflow.createFromTemplate",
  description:
    "Copy a workflow template (Software) into the org as a new workflow with its own name, to edit there. A new workflow no project runs is neutral, so it applies at once. Org admins only.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  // Decidable on the desktop with a presence proof for this exact call (ADR 0610); never the phone,
  // and never a CLI, MCP, runner or agent token.
  presenceDecidable: true,
  presenceSurfaces: ["desktop"],
  input: z.object({
    orgId,
    baseVersion,
    templateId: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    note,
  }),
  output: z.object({ version: z.number(), workflowId: z.string() }),
  async handler(input, ctx) {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) throw new OperationError("not_found", `no template ${input.templateId}`);
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    requireBase(version, input.baseVersion);
    const base = `wf_${
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 50) || "workflow"
    }`;
    let id = base;
    for (let n = 2; config.workflows.some((w) => w.id === id) || builtInKind(id); n++)
      id = `${base}_${n}`;
    const workflow: WorkflowDefinition = {
      ...template,
      id,
      name: input.name,
      template: { id: template.id, version: 1 },
    };
    const after = validated(withWorkflow(config, workflow));
    const written = await writeOrgVersion(ctx, input.orgId, version, after, {
      source: "app",
      before: config,
      note: input.note || `New workflow ${input.name}, from ${template.name}`,
    });
    return { version: written.version, workflowId: id };
  },
});

export const workflowArchive = defineOperation({
  name: "workflow.archive",
  description:
    "Remove an org workflow from the org's config (a new version; earlier versions keep it, so a rollback brings it back). Built-in workflows can't be archived. Org admins only.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  // Decidable on the desktop with a presence proof for this exact call (ADR 0610); never the phone,
  // and never a CLI, MCP, runner or agent token.
  presenceDecidable: true,
  presenceSurfaces: ["desktop"],
  input: z.object({ orgId, baseVersion, workflowId: z.string().min(1), note }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    if (builtInKind(input.workflowId))
      throw new OperationError("invalid_input", "a built-in workflow can't be archived");
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    requireBase(version, input.baseVersion);
    const workflow = config.workflows.find((w) => w.id === input.workflowId);
    if (!workflow) throw new OperationError("not_found", `no workflow ${input.workflowId}`);
    // A workflow a project runs can't be archived: the project would have nothing to run. The
    // archived version is kept: a workflow re-added under this id is compared against it (ADR 0516).
    const using = projectsOn(await orgProjects(ctx.db, input.orgId), input.workflowId);
    if (using.length)
      throw new OperationError(
        "conflict",
        `${workflow.name} is in use by ${using.join(", ")}: move ${using.length === 1 ? "it" : "them"} to another workflow first`,
        { projects: using },
      );
    // The document keeps the last version of up to MAX_ARCHIVED archived workflows. The next archive
    // is refused, never made by dropping the oldest: a dropped one could be re-added under its id
    // compared only against the Software floor (ADR 0516). Re-adding or replacing an archived
    // workflow frees its place.
    if (
      config.archived.length >= MAX_ARCHIVED &&
      !config.archived.some((w) => w.id === input.workflowId)
    )
      throw new OperationError(
        "conflict",
        `the org already keeps ${MAX_ARCHIVED} archived workflows, so this one can't be archived: re-add or replace an archived workflow first`,
      );
    const after = validated({
      ...config,
      workflows: config.workflows.filter((w) => w.id !== input.workflowId),
      archived: [...config.archived.filter((w) => w.id !== input.workflowId), workflow],
    });
    return writeOrgVersion(ctx, input.orgId, version, after, {
      source: "app",
      before: config,
      note: input.note || `Archived ${workflow.name}`,
    });
  },
});

export const agentSave = defineOperation({
  name: "agent.save",
  description:
    "Add an org agent, or replace one by name (ADR 0372): its role, tier, instructions and capabilities. Workflow stages hand to org agents by name. A change that breaks a workflow (a role a stage can't take) is refused. Changing an agent that judges work (an agent check's) loosens, so it waits for an org admin. Org admins only.",
  risk: "write",
  riskOf: (input, at) =>
    riskOfSave(at.db, input.orgId, input.baseVersion, (c) => withAgent(c, input.agent)),
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  // Decidable on the desktop with a presence proof for this exact call (ADR 0610); never the phone,
  // and never a CLI, MCP, runner or agent token.
  presenceDecidable: true,
  presenceSurfaces: ["desktop"],
  input: z.object({ orgId, baseVersion, agent: agentSchema, note }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    return saveAgent(ctx, input);
  },
});

export function withAgent(config: OrgConfig, agent: z.infer<typeof agentSchema>): OrgConfig {
  const name = agent.name.toLowerCase();
  const exists = config.agents.some((a) => a.name.toLowerCase() === name);
  return {
    ...config,
    agents: exists
      ? config.agents.map((a) => (a.name.toLowerCase() === name ? agent : a))
      : [...config.agents, agent],
  };
}

async function saveAgent(
  ctx: HandlerContext,
  input: {
    orgId: string;
    baseVersion: number;
    agent: z.infer<typeof agentSchema>;
    note?: string | undefined;
  },
  createdBy?: string,
) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  const exists = config.agents.some((a) => a.name.toLowerCase() === input.agent.name.toLowerCase());
  const after = validated(withAgent(config, input.agent));
  return writeOrgVersion(ctx, input.orgId, version, after, {
    source: "app",
    before: config,
    note: input.note || `${exists ? "Changed" : "Added"} the agent ${input.agent.name}`,
    ...(createdBy ? { createdBy } : {}),
  });
}

const versionView = z.object({
  version: z.number(),
  source: z.string(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  /** How this version changed the one before it. */
  impact: z.enum(["loosens", "tightens", "neutral"]).nullable(),
});

export const orgConfigGet = defineOperation({
  name: "orgConfig.get",
  description:
    "An org's config (spec 52): the current version's workflows and agents, the last 50 versions with what each one loosened or tightened, and saves waiting for an org admin. Members only.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ orgId }),
  output: z.object({
    version: z.number(),
    config: definitionView,
    history: z.array(versionView),
    pending: z.array(
      z.object({
        pendingActionId: z.string(),
        operation: z.string(),
        note: z.string().nullable(),
        by: z.string().nullable(),
        createdAt: z.string(),
        /** The org config version it was drafted on: another version means it can't apply. */
        baseVersion: z.number().nullable(),
        /** What it would save (a workflow, an agent) and what is there now, for the difference. */
        proposal: z.record(z.string(), z.unknown()).nullable(),
        current: z.record(z.string(), z.unknown()).nullable(),
        toVersion: z.number().nullable(),
        /** The engine's classification against the current version; null if it can't be read. */
        impact: impactView.nullable(),
      }),
    ),
  }),
  async handler(input, ctx) {
    // The current version is the one document parsed. The history is metadata only: each version's
    // impact was recorded when it was written, so no older document is read or parsed here.
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const rows = await ctx.db
      .selectFrom("core_org_configs as c")
      .leftJoin("core_user as u", "u.id", "c.created_by")
      .select([
        "c.version",
        "c.source",
        "c.note",
        "c.impact",
        "c.created_at",
        "u.github_login",
        "u.name",
      ])
      .where("c.org_id", "=", input.orgId)
      .orderBy("c.version", "desc")
      .limit(50)
      .execute();
    const history = rows.map((r) => ({
      version: r.version,
      source: r.source,
      note: r.note,
      createdBy: r.github_login ?? r.name ?? null,
      createdAt: r.created_at,
      impact: r.impact,
    }));
    const waiting = await ctx.db
      .selectFrom("core_pending_actions as pa")
      .leftJoin("core_user as u", "u.id", "pa.actor_id")
      .select(["pa.id", "pa.operation", "pa.input", "pa.created_at", "u.github_login", "u.name"])
      .where("pa.org_id", "=", input.orgId)
      .where("pa.project_id", "is", null)
      .where("pa.status", "=", "pending")
      .where("pa.operation", "in", [...ORG_CONFIG_WRITES])
      .orderBy("pa.created_at", "desc")
      .limit(20)
      .execute();
    const pending = [];
    for (const p of waiting) pending.push(await pendingOrgChange(ctx.db, input.orgId, config, p));
    return { version, config, history, pending };
  },
});

export const orgConfigRollback = defineOperation({
  name: "orgConfig.rollback",
  description:
    "Make an earlier version of an org's config current again, as a new version (source `rollback`). Judged like any save: one that loosens waits for an org admin. Org admins only.",
  risk: "write",
  async riskOf(input, at) {
    const target = await storedOrgConfig(at.db, input.orgId, input.toVersion);
    return target ? riskOfSave(at.db, input.orgId, input.baseVersion, () => target) : "write";
  },
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  // Decidable on the desktop with a presence proof for this exact call (ADR 0610); never the phone,
  // and never a CLI, MCP, runner or agent token.
  presenceDecidable: true,
  presenceSurfaces: ["desktop"],
  input: z.object({ orgId, baseVersion, toVersion: z.number().int().positive(), note }),
  output: z.object({ version: z.number(), impact: impactView }),
  async handler(input, ctx) {
    return rollbackOrgConfig(ctx, input);
  },
});

async function rollbackOrgConfig(
  ctx: HandlerContext,
  input: { orgId: string; baseVersion: number; toVersion: number; note?: string | undefined },
  createdBy?: string,
) {
  const target = await storedOrgConfig(ctx.db, input.orgId, input.toVersion);
  if (!target) throw new OperationError("not_found", `no valid version ${input.toVersion}`);
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  requireBase(version, input.baseVersion);
  const impact = orgConfigImpact(config, target);
  const written = await writeOrgVersion(ctx, input.orgId, version, target, {
    source: "rollback",
    before: config,
    note: input.note || `Rolled back to v${input.toVersion}`,
    ...(createdBy ? { createdBy } : {}),
  });
  return { ...written, impact };
}

/**
 * Applies an approved org config proposal (a loosening `workflow.save` or `orgConfig.rollback`) in
 * the approver's call: an org-level pending action has no Workflow to re-run it. The proposer stays
 * its author. Refuses, deciding nothing, when the config moved on or no longer validates.
 */
/** The skill operations' writes, applied when an org admin approves a loosening one (ADR 0513). */
export type SkillWrite = (
  ctx: HandlerContext,
  input: unknown,
  createdBy?: string,
) => Promise<{ version: number }>;
export const SKILL_WRITES: Record<string, SkillWrite> = {};

export async function applyApprovedOrgConfig(
  ctx: HandlerContext,
  pa: { id: string; operation: string; input: string; actor_id: string },
): Promise<{ version: number }> {
  const input = JSON.parse(pa.input);
  const skill = SKILL_WRITES[pa.operation];
  const written = skill
    ? await skill(ctx, input, pa.actor_id)
    : pa.operation === "orgConfig.rollback"
      ? await rollbackOrgConfig(ctx, input, pa.actor_id)
      : pa.operation === "agent.save"
        ? await saveAgent(ctx, input, pa.actor_id)
        : await saveWorkflow(ctx, input, pa.actor_id);
  ctx.writePendingStatus(
    "apply",
    ctx.db.updateTable("core_pending_actions").set({ status: "applied" }).where("id", "=", pa.id),
  );
  return written;
}

const typeView = z.object({
  id: z.string(),
  version: z.number(),
  name: z.string(),
  description: z.string(),
  phases: z.array(z.string()),
  surface: z.string(),
  small: z.boolean(),
  reversibility: z.string(),
  needsPerson: z.boolean(),
  consumes: z.array(z.string()),
  produces: z.array(z.string()),
  gate: z.object({ kind: z.string(), mode: z.string(), on: z.string() }).nullable(),
  requires: z.object({
    capabilities: z.array(z.string()),
    connectors: z.array(z.string()),
    repository: z.boolean(),
    pool: z.string(),
    roles: z.array(z.string()),
  }),
  /** The settings as JSON Schema, for the editor. */
  settingsSchema: z.record(z.string(), z.unknown()),
  defaults: z.record(z.string(), z.unknown()),
});

export const stageTypeList = defineOperation({
  name: "stageType.list",
  description:
    "The built-in stage types (spec 52): each one's phases, screen, gate, reversibility, what it consumes and produces, what it needs, and its settings as JSON Schema with defaults, for the workflow editor.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "signed-in",
  input: z.object({}),
  output: z.object({ types: z.array(typeView) }),
  async handler() {
    return {
      types: STAGE_TYPES.map((t) => {
        const defaults = t.settings.parse({}) as Record<string, unknown>;
        const gate = t.gate(defaults);
        return {
          id: t.id,
          version: t.version,
          name: t.name,
          description: t.description,
          phases: [...t.phases],
          surface: t.surface,
          small: t.small === true,
          reversibility: t.reversibility,
          needsPerson: t.needsPerson,
          consumes: [...t.consumes],
          produces: [...t.produces],
          gate: gate ? { kind: gate.kind, mode: gate.mode, on: gate.on } : null,
          requires: (({ capabilities, connectors, repository, pool, roles }) => ({
            capabilities: [...capabilities],
            connectors: [...connectors],
            repository,
            pool,
            roles: [...roles],
          }))(t.requires(defaults)),
          settingsSchema: z.toJSONSchema(t.settings, { io: "input" }) as Record<string, unknown>,
          defaults,
        };
      }),
    };
  },
});

/**
 * A waiting org change as an approver sees it (ADR 0610, review of #159): what it would save, what
 * is there now, and the engine's classification against the current version. Bounded: at most 20
 * are listed, and only a rollback reads a stored version (by primary key).
 */
async function pendingOrgChange(
  db: Db,
  orgId: string,
  config: OrgConfig,
  p: {
    id: string;
    operation: string;
    input: string;
    created_at: string;
    github_login: string | null;
    name: string | null;
  },
) {
  let input: Record<string, unknown> = {};
  try {
    const v = JSON.parse(p.input) as unknown;
    if (v && typeof v === "object") input = v as Record<string, unknown>;
  } catch {
    input = {};
  }
  const obj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const toVersion = typeof input.toVersion === "number" ? input.toVersion : null;
  let proposal: Record<string, unknown> | null = null;
  let current: Record<string, unknown> | null = null;
  let after: OrgConfig | null = null;
  try {
    if (p.operation === "workflow.save") {
      proposal = obj(input.workflow);
      const id = proposal?.id;
      current =
        (config.workflows.find((w) => w.id === id) as unknown as Record<string, unknown>) ?? null;
      if (proposal) after = withWorkflow(config, proposal as unknown as WorkflowDefinition);
    } else if (p.operation === "agent.save") {
      proposal = obj(input.agent);
      const name = String(proposal?.name ?? "").toLowerCase();
      current =
        (config.agents.find((a) => a.name.toLowerCase() === name) as unknown as Record<
          string,
          unknown
        >) ?? null;
      if (proposal) after = withAgent(config, proposal as never);
    } else if (p.operation === "orgConfig.rollback" && toVersion !== null) {
      after = await storedOrgConfig(db, orgId, toVersion);
      // The whole org config, now and as the rollback would make it: every workflow and agent
      // compared field by field before anyone approves it (review of #159, round 4).
      // The whole org config on both sides: a rollback replaces all of it (workflows, built-in
      // copies, agents, archived versions), so the desktop shows every part (review of #159, 5).
      current = config as unknown as Record<string, unknown>;
      proposal = after ? (after as unknown as Record<string, unknown>) : null;
    }
  } catch {
    after = null;
  }
  const parsed = after ? parseOrgConfig(after) : null;
  return {
    pendingActionId: p.id,
    operation: p.operation,
    note:
      (typeof input.note === "string" ? input.note : null) ??
      (p.operation === "orgConfig.rollback" ? `Roll back to v${toVersion}` : null),
    by: p.github_login ?? p.name ?? null,
    createdAt: p.created_at,
    baseVersion: typeof input.baseVersion === "number" ? input.baseVersion : null,
    proposal,
    current,
    toVersion,
    impact: parsed?.ok ? orgConfigImpact(config, parsed.config) : null,
  };
}

export const orgConfigPreviewRollback = defineOperation({
  name: "orgConfig.previewRollback",
  description:
    "What rolling an org's workflows back to an earlier version would change, as the engine classifies it against the current version (each change loosens, tightens or is neutral), and the workflows before and after, before a person confirms. Members only.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ orgId, toVersion: z.number().int().positive() }),
  output: z.object({
    impact: impactView,
    /** The version this was compared against: the rollback names it as its base. */
    currentVersion: z.number(),
    before: z.array(z.object({ id: z.string(), name: z.string() })),
    after: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const target = await storedOrgConfig(ctx.db, input.orgId, input.toVersion);
    if (!target) throw new OperationError("not_found", `no valid version ${input.toVersion}`);
    const names = (c: OrgConfig) => c.workflows.map((w) => ({ id: w.id, name: w.name }));
    return {
      impact: orgConfigImpact(config, target),
      currentVersion: version,
      before: names(config),
      after: names(target),
    };
  },
});
