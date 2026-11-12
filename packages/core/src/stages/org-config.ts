// An org's config document (spec 52 PR (b), ADR 0510): its workflows and agents, defined once and
// used by its projects, with the tightened copies of the built-in workflows. Stored as versions in
// `core_org_configs` (migration 0280) and written only through the `workflow.*` operations.
import { z } from "zod";
import { type AgentConfig, agentSchema } from "../policy/project-policy.ts";
import {
  ATTACHED_PR,
  BUILT_IN_WORKFLOWS,
  INCIDENT,
  SOFTWARE,
  WORKFLOW_TEMPLATES,
} from "./builtins.ts";
import type { ArtifactKind } from "./contract.ts";
import { workflowImpact } from "./impact.ts";
import { validateWorkflow, type WorkflowError } from "./validate.ts";
import { type WorkflowDefinition, workflowDefinitionSchema } from "./workflow.ts";

export const MAX_ORG_WORKFLOWS = 30;
/** The last versions of archived workflows the document keeps (ADR 0516). */
export const MAX_ARCHIVED = 200;
/**
 * The stored document's size in bytes (its pretty JSON, as `core_org_configs.raw` holds it). Well
 * under D1's row limit, and small enough that `currentOrgConfig` parses it on every org config read
 * without cost: the schema's own maxima (30 workflows, 200 archived, 20 stages, 4,000 characters of
 * instructions a stage) would allow tens of megabytes.
 */
export const MAX_ORG_CONFIG_BYTES = 256 * 1024;
/** All stage instructions in one workflow together, in characters. */
export const MAX_WORKFLOW_INSTRUCTIONS = 16_000;

/** The document as it is stored: pretty JSON and a newline. Its size is what the cap measures. */
export function orgConfigRaw(config: OrgConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export const orgConfigSchema = z
  .object({
    version: z.literal(1),
    agents: z.array(agentSchema).max(30).default([]),
    workflows: z.array(workflowDefinitionSchema).max(MAX_ORG_WORKFLOWS).default([]),
    /** The org's tightened copies of the built-in workflows, by the item kind that runs them (Q10). */
    builtIns: z
      .object({
        incident: workflowDefinitionSchema.optional(),
        attached: workflowDefinitionSchema.optional(),
      })
      .strict()
      .default({}),
    /**
     * The last version of each archived workflow, by id (ADR 0516): a workflow re-added under the
     * same id is compared against it, so archiving and re-adding can't drop a gate unnoticed.
     */
    archived: z.array(workflowDefinitionSchema).max(MAX_ARCHIVED).default([]),
  })
  .strict();
export type OrgConfig = z.infer<typeof orgConfigSchema>;

export const EMPTY_ORG_CONFIG: OrgConfig = {
  version: 1,
  agents: [],
  workflows: [],
  builtIns: {},
  archived: [],
};

/**
 * What a save of workflow `id` is compared against (ADR 0516): the org's current version of it,
 * else the last version archived under that id, else the built-in floor for a change item (the
 * Software workflow), so a brand-new workflow with fewer gates than Software is a loosening.
 */
export function baselineFor(config: OrgConfig, id: string): WorkflowDefinition {
  const current = config.workflows.find((w) => w.id === id);
  if (current) return current;
  const archived = config.archived.find((w) => w.id === id);
  if (archived) return archived;
  return { ...SOFTWARE, id };
}

export type BuiltInKind = keyof typeof BUILT_IN_WORKFLOWS;
const BUILT_IN_BY_ID: ReadonlyMap<string, BuiltInKind> = new Map([
  [INCIDENT.id, "incident"],
  [ATTACHED_PR.id, "attached"],
]);

/** The built-in kind a workflow id names, if it is a built-in's. */
export const builtInKind = (id: string): BuiltInKind | undefined => BUILT_IN_BY_ID.get(id);

/** What an item of a built-in kind arrives with (an attached PR brings its own head). */
export const BRINGS: Record<BuiltInKind, readonly ArtifactKind[]> = {
  incident: [],
  attached: ["git-head"],
};

/** A built-in workflow as the org runs it: its tightened copy, or the shipped one. */
export function builtIn(config: OrgConfig, kind: BuiltInKind): WorkflowDefinition {
  return config.builtIns[kind] ?? BUILT_IN_WORKFLOWS[kind];
}

export interface OrgConfigError extends WorkflowError {
  /** The workflow it is about; null for the document. */
  workflowId: string | null;
}

export type OrgConfigParse =
  | { ok: true; config: OrgConfig }
  | { ok: false; errors: OrgConfigError[] };

/**
 * Parses and validates a whole document: every workflow passes `validateWorkflow` against the
 * org's agents, ids and names are unique, no workflow takes a built-in or template id, and every
 * built-in copy only tightens the shipped one. Settings come back with their defaults filled.
 */
export function parseOrgConfig(input: unknown): OrgConfigParse {
  const parsed = orgConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        rule: "schema",
        stageId: null,
        workflowId: null,
        message: `${i.path.join(".") || "config"}: ${i.message}`,
      })),
    };
  }
  const config = parsed.data;
  const errors: OrgConfigError[] = [];
  const doc = (message: string, workflowId: string | null = null) =>
    errors.push({ rule: "schema", stageId: null, workflowId, message });
  const bytes = new TextEncoder().encode(orgConfigRaw(config)).length;
  if (bytes > MAX_ORG_CONFIG_BYTES)
    doc(
      `the org config is ${Math.ceil(bytes / 1024)} KiB; it can be at most ${MAX_ORG_CONFIG_BYTES / 1024} KiB (shorten instructions, or remove workflows)`,
    );
  for (const w of [...config.workflows, ...Object.values(config.builtIns)]) {
    if (!w) continue;
    const chars = w.stages.reduce((n, s) => {
      const i = (s.settings as { instructions?: unknown } | undefined)?.instructions;
      return n + (typeof i === "string" ? i.length : 0);
    }, 0);
    if (chars > MAX_WORKFLOW_INSTRUCTIONS)
      doc(
        `${w.name}'s stage instructions come to ${chars} characters; a workflow's can be at most ${MAX_WORKFLOW_INSTRUCTIONS}`,
        w.id,
      );
  }
  const agentNames = new Set<string>();
  for (const a of config.agents) {
    if (agentNames.has(a.name.toLowerCase())) doc(`two agents are called "${a.name}"`);
    agentNames.add(a.name.toLowerCase());
  }
  const reserved = new Set([...BUILT_IN_BY_ID.keys(), ...WORKFLOW_TEMPLATES.map((t) => t.id)]);
  const ids = new Set<string>();
  const names = new Set<string>();
  const check = (def: WorkflowDefinition, brings: readonly ArtifactKind[] = []) => {
    const v = validateWorkflow(def, { agents: config.agents as AgentConfig[], brings });
    if (!v.valid) {
      for (const e of v.errors) errors.push({ ...e, workflowId: def.id });
      return def;
    }
    return v.definition;
  };
  const workflows = config.workflows.map((w) => {
    if (reserved.has(w.id)) doc(`"${w.id}" is a built-in workflow's id`, w.id);
    if (ids.has(w.id)) doc(`two workflows have the id "${w.id}"`, w.id);
    if (names.has(w.name.toLowerCase())) doc(`two workflows are called "${w.name}"`, w.id);
    ids.add(w.id);
    names.add(w.name.toLowerCase());
    return check(w);
  });
  const builtIns: OrgConfig["builtIns"] = {};
  for (const kind of Object.keys(BUILT_IN_WORKFLOWS) as BuiltInKind[]) {
    const copy = config.builtIns[kind];
    if (!copy) continue;
    const shipped = BUILT_IN_WORKFLOWS[kind];
    if (copy.id !== shipped.id) doc(`the ${kind} built-in keeps its id ${shipped.id}`, copy.id);
    const checked = check(copy, BRINGS[kind]);
    const loosened = workflowImpact(shipped, checked).changes.filter((c) => c.class === "loosens");
    for (const c of loosened)
      doc(`a built-in workflow can only be tightened: ${c.summary}`, copy.id);
    builtIns[kind] = checked;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: { ...config, workflows, builtIns } };
}

/** The first error as one line, for a refusal. */
export function orgConfigErrorText(errors: readonly OrgConfigError[]): string {
  const e = errors[0];
  if (!e) return "invalid";
  const where = [e.workflowId, e.stageId].filter(Boolean).join(" → ");
  return `${e.rule === "schema" ? "" : `${e.rule}: `}${where ? `${where}: ` : ""}${e.message}`;
}
