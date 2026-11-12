// Moving each project's slot workflow to the org (spec 52 PR (d), "Migration", steps 2–5). An org
// admin runs `orgConfig.adoptProjectWorkflows` once: every project still on its own slot workflow (or
// the skeleton alone) gets the same workflow as an org workflow, named by id, with its own values of
// the overridable settings as overrides. It changes nothing an item does: each project's save must
// classify neutral against what it runs now, or that project is left as it is and the reason given.
// A dry run reports what it would write and writes nothing.
import type { Db } from "@software-factory/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { policyImpact, same } from "../policy/impact.ts";
import {
  type AgentConfig,
  onOrgWorkflow,
  type ProjectPolicy,
  parseProjectPolicy,
} from "../policy/project-policy.ts";
import { BUILT_IN_WORKFLOWS, SOFTWARE } from "../stages/builtins.ts";
import { CompileError, compileProjectWorkflow } from "../stages/compile.ts";
import { summarise } from "../stages/impact.ts";
import { type OrgConfig, orgConfigErrorText, parseOrgConfig } from "../stages/org-config.ts";
import {
  configImpact,
  normaliseOverrides,
  resolveProjectWorkflow,
  type WorkflowOverrides,
} from "../stages/project-workflow.ts";
import { stageType } from "../stages/registry.ts";
import type { StageInstance, WorkflowDefinition } from "../stages/workflow.ts";
import { formatPolicy, writeVersion } from "./config.ts";
import { currentOrgConfig, orgConfigImpact, writeOrgVersion } from "./workflows.ts";

/** The settings a project may override (spec 52, Q5): they become its overrides, never the org's. */
const OVERRIDABLE: readonly { stage: string; key: string }[] = [
  { stage: "spec", key: "requiredFrom" },
  { stage: "build", key: "retryLimit" },
  { stage: "verify", key: "requiredChecks" },
  { stage: "verify", key: "sections" },
];

/** The most projects one run adopts; more fails closed (the admin runs it again after). */
const MAX_PROJECTS = 200;

/** A stage's settings with its type's defaults filled in. */
function parsedSettings(s: StageInstance): Record<string, unknown> {
  const parsed = stageType(s.type)?.settings.safeParse(s.settings ?? {});
  return (parsed?.success ? parsed.data : (s.settings ?? {})) as Record<string, unknown>;
}

const SOFTWARE_VALUES: Record<string, Record<string, unknown>> = Object.fromEntries(
  SOFTWARE.stages.map((s) => [s.id, parsedSettings(s)]),
);

/**
 * A compiled project workflow split in two: its shape, with the overridable settings at Software's
 * values (what the org workflow holds, so it is never looser than the floor for them), and the
 * project's own values of those settings (its overrides).
 */
function split(def: WorkflowDefinition): {
  shape: WorkflowDefinition;
  values: WorkflowOverrides;
} {
  const values: WorkflowOverrides = {};
  const stages = def.stages.map((s) => {
    const mine = OVERRIDABLE.filter((o) => o.stage === s.id);
    if (!mine.length) return s;
    const settings = { ...(s.settings as Record<string, unknown>) };
    const own = parsedSettings(s);
    for (const { key } of mine) {
      const floor = SOFTWARE_VALUES[s.id]?.[key];
      if (!same(own[key], floor)) values[s.id] = { ...values[s.id], [key]: own[key] };
      if (floor === undefined) delete settings[key];
      else settings[key] = floor;
    }
    return { ...s, settings };
  });
  return { shape: { ...def, stages }, values };
}

/** What makes two definitions the same workflow: name and stages, settings with defaults. */
function keyOf(def: WorkflowDefinition): string {
  return JSON.stringify(
    sortKeys({
      name: def.name,
      stages: def.stages.map((s) => ({
        id: s.id,
        type: s.type,
        typeVersion: s.typeVersion,
        name: s.name,
        phase: s.phase,
        settings: parsedSettings(s),
        when: s.when ?? null,
        agent: s.agent ?? null,
      })),
    }),
  );
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "workflow";

const agentBody = (a: AgentConfig) =>
  JSON.stringify(sortKeys({ ...a, name: undefined, requires: [...a.requires].sort() }));

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  policy_sha: string | null;
  raw: string | null;
  valid: number | null;
  latest: number | null;
}

async function projectsOf(db: Db, org: string): Promise<ProjectRow[]> {
  // An admin's one-off act: the org's projects by the (org_id, slug) unique index, each current
  // config row by primary key, and each project's highest version by core_project_policies_version_idx.
  const rows = await db
    .selectFrom("core_projects as p")
    .leftJoin("core_project_policies as pp", (j) =>
      j.onRef("pp.project_id", "=", "p.id").onRef("pp.sha", "=", "p.policy_sha"),
    )
    .select([
      "p.id",
      "p.name",
      "p.slug",
      "p.policy_sha",
      "pp.raw",
      "pp.valid",
      sql<
        number | null
      >`(SELECT max(v.version) FROM core_project_policies v WHERE v.project_id = p.id)`.as(
        "latest",
      ),
    ])
    .where("p.org_id", "=", org)
    .orderBy("p.slug")
    .limit(MAX_PROJECTS + 1)
    .execute();
  if (rows.length > MAX_PROJECTS)
    throw new OperationError(
      "conflict",
      `the org has more than ${MAX_PROJECTS} projects: adopting them in one run isn't supported`,
    );
  return rows.map((r) => ({ ...r, latest: (r.latest as number | null) ?? null }));
}

const changeView = z.object({ path: z.string(), class: z.string(), summary: z.string() });

export const orgConfigAdoptProjectWorkflows = defineOperation({
  name: "orgConfig.adoptProjectWorkflows",
  description:
    "Move every project still on its own slot workflow (or the skeleton alone) onto an org workflow (spec 52, migration): the same stages, as one org workflow per distinct workflow (identical ones shared; a name two different ones share gets the project's slug), the projects' agents added to the org's (a same-named, different agent gets the project's slug), and each project's own spec size, retry limit, required checks and review sections as its overrides, approved by this run. Nothing an item does changes: a project whose move wouldn't classify neutral is left as it is, with the reason. Items in flight keep the versions they pinned. `dryRun: true` reports what it would write and writes nothing. Org admins only.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  browserOnly: true,
  input: z.object({
    orgId: z.string().min(1),
    /** The org config version this was planned from (0 before the first): a stale one is a conflict. */
    baseVersion: z.number().int().nonnegative(),
    dryRun: z.boolean().default(true),
  }),
  output: z.object({
    dryRun: z.boolean(),
    /** The org config version written, or that would be; null when there is nothing to adopt. */
    orgVersion: z.number().nullable(),
    workflows: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        added: z.boolean(),
        projects: z.array(z.string()),
      }),
    ),
    agents: z.array(z.string()),
    projects: z.array(
      z.object({
        projectId: z.string(),
        name: z.string(),
        from: z.string().nullable(),
        workflow: z.string(),
        overrides: z.record(z.string(), z.record(z.string(), z.unknown())),
        /** Its overrides looser than the org workflow's value, approved by this run (an org admin's). */
        approved: z.array(z.string()),
        version: z.number().nullable(),
        changes: z.array(changeView),
      }),
    ),
    skipped: z.array(z.object({ projectId: z.string(), name: z.string(), reason: z.string() })),
  }),
  async handler(input, ctx) {
    return adopt(ctx, input);
  },
});

async function adopt(
  ctx: HandlerContext,
  input: { orgId: string; baseVersion: number; dryRun: boolean },
) {
  const { version, config } = await currentOrgConfig(ctx.db, input.orgId);
  if (version !== input.baseVersion)
    throw new OperationError(
      "conflict",
      `the org config moved on: it's at v${version}, this was planned from v${input.baseVersion}. Plan again.`,
      { currentVersion: version },
    );
  const rows = await projectsOf(ctx.db, input.orgId);
  const skipped: { projectId: string; name: string; reason: string }[] = [];
  const agents = [...config.agents];
  const addedAgents: string[] = [];
  const workflows = [...config.workflows];
  const byKey = new Map<string, WorkflowDefinition>(
    [SOFTWARE, ...config.workflows].map((w) => [keyOf(split(w).shape), w]),
  );
  const added = new Set<string>();
  const usedBy = new Map<string, string[]>();
  const planned: {
    row: ProjectRow;
    before: ProjectPolicy;
    doc: Record<string, unknown>;
    from: string | null;
    id: string;
    values: WorkflowOverrides;
  }[] = [];
  const taken = (id: string) =>
    workflows.some((w) => w.id === id) ||
    Object.values(BUILT_IN_WORKFLOWS).some((w) => w.id === id) ||
    id === SOFTWARE.id;

  for (const row of rows) {
    const skip = (reason: string) => skipped.push({ projectId: row.id, name: row.name, reason });
    const parsed = row.valid && row.raw ? parseProjectPolicy(row.raw) : null;
    if (!parsed?.ok) {
      skip("it has no valid config");
      continue;
    }
    const before = parsed.policy;
    if (onOrgWorkflow(before)) continue; // already on one
    if (before.workflows.length > 0 && !before.workflow) {
      skip("it defines workflows but names none for its items");
      continue;
    }
    let compiled: WorkflowDefinition;
    try {
      compiled = compileProjectWorkflow(before, before.workflow);
    } catch (e) {
      skip(e instanceof CompileError ? e.message : "its workflow doesn't compile");
      continue;
    }
    // The agents its stages hand to, as org agents: the same one shared, a different one renamed.
    const rename = new Map<string, string>();
    for (const s of compiled.stages) {
      if (!s.agent || rename.has(s.agent.toLowerCase())) continue;
      const own = before.agents.find((a) => a.name.toLowerCase() === s.agent?.toLowerCase());
      if (!own) continue;
      let name = own.name;
      for (let n = 1; ; n++) {
        const there = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
        if (!there) {
          agents.push({ ...own, name, requires: [...own.requires] });
          addedAgents.push(name);
          break;
        }
        if (agentBody(there) === agentBody(own)) break;
        name = `${own.name} (${row.slug}${n > 1 ? ` ${n}` : ""})`.slice(0, 60);
      }
      rename.set(s.agent.toLowerCase(), name);
    }
    const withAgents: WorkflowDefinition = {
      ...compiled,
      stages: compiled.stages.map((s) =>
        s.agent ? { ...s, agent: rename.get(s.agent.toLowerCase()) ?? s.agent } : s,
      ),
    };
    const { shape, values } = split(withAgents);
    let def = byKey.get(keyOf(shape));
    if (!def) {
      const sameName = workflows.some((w) => w.name.toLowerCase() === shape.name.toLowerCase());
      const name = sameName ? `${shape.name} (${row.slug})`.slice(0, 100) : shape.name;
      let id = `wf_${slug(name)}`;
      for (let n = 2; taken(id); n++) id = `wf_${slug(name)}_${n}`;
      def = { ...shape, id, name };
      workflows.push(def);
      added.add(id);
      byKey.set(keyOf(shape), def);
    }
    const doc = JSON.parse(row.raw as string) as Record<string, unknown>;
    planned.push({ row, before, doc, from: before.workflow, id: def.id, values });
    usedBy.set(def.id, [...(usedBy.get(def.id) ?? []), row.name]);
  }

  const after = parseOrgConfig({ ...config, agents, workflows });
  if (!after.ok)
    throw new OperationError(
      "invalid_input",
      `the org config this would write isn't valid: ${orgConfigErrorText(after.errors)}`,
    );
  // An agent new to the org judges only in the workflows this run adds (an org config only refers to
  // agents it has), and those are compared with the Software floor stage by stage: its own "changed"
  // line isn't a loosening of anything the org had.
  const newAgent = new Set(addedAgents.map((a) => `agents.${a}`));
  const orgImpact = summarise(
    orgConfigImpact(config, after.config).changes.filter((c) => !newAgent.has(c.path)),
  );
  if (orgImpact.class === "loosens")
    throw new OperationError(
      "conflict",
      `adopting the projects' workflows would loosen the org's config: ${orgImpact.changes
        .filter((c) => c.class === "loosens")
        .map((c) => c.summary)
        .join(" ")}`,
    );
  const nextVersion = version + 1;

  const projects: {
    projectId: string;
    name: string;
    from: string | null;
    workflow: string;
    overrides: WorkflowOverrides;
    approved: string[];
    looser: { stageId: string; key: string; value: unknown }[];
    version: number | null;
    changes: { path: string; class: string; summary: string }[];
    raw: string;
    row: ProjectRow;
  }[] = [];
  for (const p of planned) {
    const active = p.from?.toLowerCase();
    const docWorkflows = Array.isArray(p.doc.workflows)
      ? (p.doc.workflows as { name?: string }[]).filter(
          (w) => !active || w.name?.toLowerCase() !== active,
        )
      : undefined;
    const draft: Record<string, unknown> = {
      ...p.doc,
      ...(docWorkflows ? { workflows: docWorkflows } : {}),
      workflow: p.id,
      workflowOverrides: p.values,
    };
    const draftPolicy = parseProjectPolicy(JSON.stringify(draft));
    if (!draftPolicy.ok) {
      skipped.push({ projectId: p.row.id, name: p.row.name, reason: draftPolicy.error });
      continue;
    }
    // Its own values; the looser ones are approved by this run (an org admin's) for the org version
    // it writes, so the project runs what it ran before.
    const n = normaliseOverrides(draftPolicy.policy, after.config);
    const stored: Record<string, unknown> = { ...draft, workflowOverrides: n.workflowOverrides };
    const now = parseProjectPolicy(JSON.stringify(stored));
    if (!now.ok) {
      skipped.push({ projectId: p.row.id, name: p.row.name, reason: now.error });
      continue;
    }
    const resolved = resolveProjectWorkflow(now.policy, after.config);
    if (resolved && !resolved.ok) {
      skipped.push({ projectId: p.row.id, name: p.row.name, reason: resolved.error });
      continue;
    }
    const impact = configImpact(
      policyImpact(p.before, now.policy, ctx.floor),
      p.before,
      now.policy,
      after.config,
    );
    if (impact.class !== "neutral") {
      skipped.push({
        projectId: p.row.id,
        name: p.row.name,
        reason: `the move isn't neutral: ${impact.changes
          .filter((c) => c.class !== "neutral")
          .map((c) => c.summary)
          .join(" ")}`,
      });
      continue;
    }
    projects.push({
      projectId: p.row.id,
      name: p.row.name,
      from: p.from,
      workflow: p.id,
      overrides: n.workflowOverrides,
      approved: n.looser.map((l) => `${l.stageId}.${l.key}`),
      looser: n.looser,
      version: input.dryRun ? null : (p.row.latest ?? 0) + 1,
      changes: impact.changes,
      raw: formatPolicy(stored),
      row: p.row,
    });
  }

  // Only the workflows and agents a project that moves uses: a skipped project's stay out.
  const kept = new Set(projects.map((p) => p.workflow));
  const writtenWorkflows = after.config.workflows.filter((w) => !added.has(w.id) || kept.has(w.id));
  const usedAgents = new Set(
    writtenWorkflows.flatMap((w) => w.stages.map((s) => s.agent?.toLowerCase() ?? "")),
  );
  const writtenAgents = after.config.agents.filter(
    (a) => !addedAgents.includes(a.name) || usedAgents.has(a.name.toLowerCase()),
  );
  const out = {
    dryRun: input.dryRun,
    orgVersion: projects.length ? nextVersion : null,
    workflows: writtenWorkflows
      .filter((w) => kept.has(w.id))
      .map((w) => ({
        id: w.id,
        name: w.name,
        added: added.has(w.id),
        projects: (usedBy.get(w.id) ?? []).filter((name) => projects.some((p) => p.name === name)),
      })),
    agents: writtenAgents.filter((a) => addedAgents.includes(a.name)).map((a) => a.name),
    projects: projects.map(({ raw: _r, row: _row, looser: _l, ...rest }) => rest),
    skipped,
  };
  // Software itself is a built-in: a project on it names `wf_software` with no org workflow.
  if (
    projects.some((p) => p.workflow === SOFTWARE.id) &&
    !out.workflows.some((w) => w.id === SOFTWARE.id)
  )
    out.workflows.push({
      id: SOFTWARE.id,
      name: SOFTWARE.name,
      added: false,
      projects: projects.filter((p) => p.workflow === SOFTWARE.id).map((p) => p.name),
    });
  if (input.dryRun || projects.length === 0) return out;

  const written: OrgConfig = {
    ...after.config,
    workflows: writtenWorkflows,
    agents: writtenAgents,
  };
  await writeOrgVersion(ctx, input.orgId, version, written, {
    source: "migrated",
    before: config,
    note: `Adopted ${projects.length} project workflow${projects.length === 1 ? "" : "s"}`,
  });
  for (const p of projects) {
    for (const l of p.looser)
      ctx.write(
        ctx.db.insertInto("core_override_approvals").values({
          project_id: p.projectId,
          org_id: input.orgId,
          org_version: nextVersion,
          stage_id: l.stageId,
          setting: l.key,
          value: JSON.stringify(l.value),
          approved_by: ctx.actor.id,
          approved_at: ctx.now,
        }),
      );
    await writeVersion(ctx, p.row, {
      raw: p.raw,
      valid: true,
      error: null,
      source: "migrated",
      note: `Moved onto the org workflow ${p.workflow}`,
      latest: p.row.latest,
    });
  }
  return out;
}
