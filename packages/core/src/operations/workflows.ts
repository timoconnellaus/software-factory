// Org workflows as versioned config (spec 52 PR (b), ADR 0510). An org's workflows and agents live
// in `core_org_configs` versions, written only through these operations with ADR 0370's machinery:
// validate first, a stale base is a conflict, and a save that loosens is `self-modify`, which an
// org admin approves (Q6). Built-in workflows (Attached PR, Incident) are visible and may only be
// tightened (Q10). Projects still run their own config: nothing here changes what an item does
// until PR (d) points projects at org workflows.
import type { Db } from "@software-factory/db";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { ImpactChange, PolicyImpact } from "../policy/impact.ts";
import { agentSchema } from "../policy/project-policy.ts";
import { BUILT_IN_WORKFLOWS, WORKFLOW_TEMPLATES } from "../stages/builtins.ts";
import { summarise, workflowImpact } from "../stages/impact.ts";
import {
  BRINGS,
  type BuiltInKind,
  baselineFor,
  builtIn,
  builtInKind,
  EMPTY_ORG_CONFIG,
  type OrgConfig,
  orgConfigErrorText,
  parseOrgConfig,
} from "../stages/org-config.ts";
import { STAGE_TYPES } from "../stages/registry.ts";
import { validateWorkflow } from "../stages/validate.ts";
import { type WorkflowDefinition, workflowDefinitionSchema } from "../stages/workflow.ts";

/** The org config operations whose loosening calls wait for an org admin. */
export const ORG_CONFIG_WRITES = ["workflow.save", "orgConfig.rollback"] as const;

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

async function storedOrgConfig(db: Db, org: string, version: number): Promise<OrgConfig | null> {
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
  if (JSON.stringify(before.agents) !== JSON.stringify(after.agents))
    changes.push({ path: "agents", class: "neutral", summary: "Agents changed." });
  return summarise(changes);
}

function requireBase(version: number, base: number) {
  if (version !== base) {
    throw new OperationError(
      "conflict",
      `the org config moved on: it's at v${version}, this was edited from v${base}. Reload and save again.`,
      { currentVersion: version },
    );
  }
}

function validated(doc: unknown): OrgConfig {
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
function withWorkflow(config: OrgConfig, workflow: WorkflowDefinition): OrgConfig {
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
  },
): Promise<{ version: number }> {
  const version = expect + 1;
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
      raw: `${JSON.stringify(config, null, 2)}\n`,
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
  // Config is a decision made in the app (ADR 0340): never from the CLI, MCP, a desktop device or
  // any other token an agent session might hold.
  browserOnly: true,
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
  input: z.object({ orgId, baseVersion, workflowId: z.string().min(1), note }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    if (builtInKind(input.workflowId))
      throw new OperationError("invalid_input", "a built-in workflow can't be archived");
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    requireBase(version, input.baseVersion);
    const workflow = config.workflows.find((w) => w.id === input.workflowId);
    if (!workflow) throw new OperationError("not_found", `no workflow ${input.workflowId}`);
    // Projects run their own config until spec 52 PR (d), so no org workflow is in use yet; (d)
    // refuses archiving one a project runs. The archived version is kept: a workflow re-added under
    // this id is compared against it (ADR 0516).
    const after = validated({
      ...config,
      workflows: config.workflows.filter((w) => w.id !== input.workflowId),
      archived: [...config.archived.filter((w) => w.id !== input.workflowId), workflow],
    });
    return writeOrgVersion(ctx, input.orgId, version, after, {
      source: "app",
      note: input.note || `Archived ${workflow.name}`,
    });
  },
});

export const agentSave = defineOperation({
  name: "agent.save",
  description:
    "Add an org agent, or replace one by name (ADR 0372): its role, tier, instructions and capabilities. Workflow stages hand to org agents by name. A change that breaks a workflow (a role a stage can't take) is refused. Org admins only.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  input: z.object({ orgId, baseVersion, agent: agentSchema, note }),
  output: z.object({ version: z.number() }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    requireBase(version, input.baseVersion);
    const name = input.agent.name.toLowerCase();
    const exists = config.agents.some((a) => a.name.toLowerCase() === name);
    const after = validated({
      ...config,
      agents: exists
        ? config.agents.map((a) => (a.name.toLowerCase() === name ? input.agent : a))
        : [...config.agents, input.agent],
    });
    return writeOrgVersion(ctx, input.orgId, version, after, {
      source: "app",
      note: input.note || `${exists ? "Changed" : "Added"} the agent ${input.agent.name}`,
    });
  },
});

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
      }),
    ),
  }),
  async handler(input, ctx) {
    const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
    const rows = await ctx.db
      .selectFrom("core_org_configs as c")
      .leftJoin("core_user as u", "u.id", "c.created_by")
      .select([
        "c.version",
        "c.source",
        "c.note",
        "c.raw",
        "c.created_at",
        "u.github_login",
        "u.name",
      ])
      .where("c.org_id", "=", input.orgId)
      .orderBy("c.version", "desc")
      .limit(51)
      .execute();
    const parsed = rows.map((r) => {
      const p = parseOrgConfig(JSON.parse(r.raw));
      return p.ok ? p.config : null;
    });
    const history = rows.slice(0, 50).map((r, i) => {
      const now = parsed[i];
      const before = parsed[i + 1] ?? EMPTY_ORG_CONFIG;
      return {
        version: r.version,
        source: r.source,
        note: r.note,
        createdBy: r.github_login ?? r.name ?? null,
        createdAt: r.created_at,
        impact: now ? orgConfigImpact(before, now).class : null,
      };
    });
    const waiting = await ctx.db
      .selectFrom("core_pending_actions as pa")
      .leftJoin("core_user as u", "u.id", "pa.actor_id")
      .select(["pa.id", "pa.operation", "pa.input", "pa.created_at", "u.github_login", "u.name"])
      .where("pa.org_id", "=", input.orgId)
      .where("pa.project_id", "is", null)
      .where("pa.status", "=", "pending")
      .where("pa.operation", "in", [...ORG_CONFIG_WRITES])
      .orderBy("pa.created_at", "desc")
      .execute();
    return {
      version,
      config,
      history,
      pending: waiting.map((p) => {
        let parsedInput: { note?: string; toVersion?: number } = {};
        try {
          parsedInput = JSON.parse(p.input);
        } catch {
          parsedInput = {};
        }
        return {
          pendingActionId: p.id,
          operation: p.operation,
          note:
            parsedInput.note ??
            (p.operation === "orgConfig.rollback"
              ? `Roll back to v${parsedInput.toVersion}`
              : null),
          by: p.github_login ?? p.name ?? null,
          createdAt: p.created_at,
        };
      }),
    };
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
export async function applyApprovedOrgConfig(
  ctx: HandlerContext,
  pa: { id: string; operation: string; input: string; actor_id: string },
): Promise<{ version: number }> {
  const input = JSON.parse(pa.input);
  const written =
    pa.operation === "orgConfig.rollback"
      ? await rollbackOrgConfig(ctx, input, pa.actor_id)
      : await saveWorkflow(ctx, input, pa.actor_id);
  ctx.write(
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
