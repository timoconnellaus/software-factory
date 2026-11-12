// `validateWorkflow`: every broken rule, each with the stage it is about (spec 52, "Validation
// rules"). S-rules are well-formedness; F-rules are the floors no setting, template or agent can
// switch off. Nothing invalid is ever saved, imported or migrated.
import { CAPABILITIES } from "@software-factory/runner-contract";
import { ALWAYS_REVIEW } from "../policy/gate.ts";
import type { AgentConfig } from "../policy/project-policy.ts";
import type { AnyStageType, ArtifactKind, ItemFacts } from "./contract.ts";
import { KNOWN_CONNECTORS, stageType, supportedVersions } from "./registry.ts";
import {
  FIXED_STATES,
  MAX_STAGES,
  STAGE_ID,
  type StageInstance,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from "./workflow.ts";

export type WorkflowRule =
  | "schema"
  | "S1"
  | "S2"
  | "S3"
  | "F1"
  | "F2"
  | "F3"
  | "F4"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9";

export interface WorkflowError {
  rule: WorkflowRule;
  /** The stage it is about; null for the workflow as a whole. */
  stageId: string | null;
  message: string;
}

export interface ValidateOptions {
  /** The agents stages may name (the org's; today the project's, ADR 0372). */
  agents: readonly AgentConfig[];
  /** Whether the project that would run it has a repository (F9). Absent: not checked. */
  hasRepository?: boolean;
  /**
   * Artifacts the item arrives with, besides its brief: an attached PR brings its own head
   * (`git-head`), which no stage of its workflow builds.
   */
  brings?: readonly ArtifactKind[];
}

export type WorkflowValidation =
  | { valid: true; errors: []; definition: WorkflowDefinition }
  | { valid: false; errors: WorkflowError[] };

/** A sample item for asking a type which steps it runs; steps don't depend on the item today. */
const ANY_ITEM: ItemFacts = { kind: "change", size: "large", domains: [], hasRepository: true };

export function validateWorkflow(input: unknown, opts: ValidateOptions): WorkflowValidation {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some(
      (i) => i.path.length === 1 && i.path[0] === "stages" && i.code === "too_big",
    );
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => ({
        rule: tooMany ? "S2" : "schema",
        stageId: null,
        message: tooMany
          ? `at most ${MAX_STAGES} stages`
          : `${i.path.join(".") || "workflow"}: ${i.message}`,
      })),
    };
  }
  const def = parsed.data;
  const errors: WorkflowError[] = [];
  const err = (rule: WorkflowRule, stageId: string | null, message: string) =>
    errors.push({ rule, stageId, message });

  // S2: ids.
  const seen = new Set<string>();
  for (const s of def.stages) {
    if (!STAGE_ID.test(s.id))
      err("S2", s.id, `"${s.id}" isn't a stage id: lowercase letters, digits and -, up to 40`);
    if ((FIXED_STATES as readonly string[]).includes(s.id))
      err("S2", s.id, `"${s.id}" is a fixed state every workflow has; pick another id`);
    if (seen.has(s.id)) err("S2", s.id, `two stages have the id "${s.id}"`);
    seen.add(s.id);
  }

  // S1: types, versions, settings. Later rules only look at stages that pass it.
  const stages: { inst: StageInstance; type: AnyStageType; settings: unknown }[] = [];
  for (const s of def.stages) {
    const type = stageType(s.type);
    if (!type) {
      err("S1", s.id, `no stage type "${s.type}"`);
      continue;
    }
    if (!supportedVersions(type.id).includes(s.typeVersion)) {
      err("S1", s.id, `${type.name} version ${s.typeVersion} is no longer run`);
      continue;
    }
    const settings = type.settings.safeParse(s.settings ?? {});
    if (!settings.success) {
      const i = settings.error.issues[0];
      err("S1", s.id, `settings ${i?.path.join(".") || ""}: ${i?.message ?? "invalid"}`.trim());
      continue;
    }
    stages.push({ inst: s, type, settings: settings.data });
  }

  // S3: agents.
  const byName = new Map(opts.agents.map((a) => [a.name.toLowerCase(), a]));
  for (const { inst, type, settings } of stages) {
    const req = type.requires(settings);
    const needsOwnAgent = type.steps(settings, ANY_ITEM).some((p) => p.kind === "agent" && !p.role);
    if (!inst.agent) {
      if (needsOwnAgent) err("S3", inst.id, `${inst.name} hands to an agent: name one`);
      continue;
    }
    if (req.roles.length === 0) {
      err("S3", inst.id, `${inst.name} is a ${type.name} stage, which hands to no agent`);
      continue;
    }
    const agent = byName.get(inst.agent.toLowerCase());
    if (!agent) err("S3", inst.id, `no agent called "${inst.agent}"`);
    else if (!(req.roles as readonly string[]).includes(agent.role))
      err(
        "S3",
        inst.id,
        `"${agent.name}" has role ${agent.role}; ${type.name} takes ${req.roles.join(" or ")}`,
      );
  }

  // F1: phases.
  let delivery = false;
  for (const { inst, type } of stages) {
    if (!type.phases.includes(inst.phase))
      err("F1", inst.id, `${type.name} can't be a ${inst.phase} stage`);
    if (inst.phase === "delivery") delivery = true;
    else if (delivery)
      err(
        "F1",
        inst.id,
        "shaping stages come before every delivery stage: release sits between them",
      );
  }
  if (!def.stages.some((s) => s.phase === "delivery"))
    err("F1", null, "a workflow needs at least one delivery stage");

  // F2–F4: shaping stages.
  for (const { inst, type, settings } of stages) {
    if (inst.phase !== "shaping") continue;
    const pool = type.requires(settings).pool;
    if (pool === "heavy")
      err("F2", inst.id, "a shaping stage holds no build slot, so it can't use the heavy pool");
    if (!type.needsPerson && !type.shapingWithoutPerson)
      err("F3", inst.id, `shaping stages need a person, and ${type.name} doesn't`);
    if (type.reversibility !== "internal")
      err("F4", inst.id, "a shaping stage acts on nothing outside the factory");
  }

  // F5: inputs.
  const produced = new Set<ArtifactKind>(["brief", ...(opts.brings ?? [])]);
  for (const { inst, type } of stages) {
    for (const kind of type.consumes) {
      if (!produced.has(kind))
        err("F5", inst.id, `${inst.name} needs a ${kind}, which no earlier stage produces`);
    }
    for (const kind of type.produces) produced.add(kind);
  }

  // F6, F7, F8: the irreversible floor.
  stages.forEach(({ inst, type, settings }, index) => {
    const gate = type.gate(settings);
    if (inst.when && (gate?.mode === "required" || type.reversibility === "irreversible"))
      err("F7", inst.id, `${inst.name} can't be skipped: its person's decision is required`);
    if (type.reversibility !== "irreversible") return;
    const action = type.action?.(settings);
    if (!action || !ALWAYS_REVIEW.includes(action.risk)) {
      err("F6", inst.id, `${inst.name} acts irreversibly without an action a person must review`);
      return;
    }
    if (gate?.mode !== "required" || gate.on !== action.on || !gate.alwaysReview)
      err(
        "F6",
        inst.id,
        `${inst.name} needs a required person's decision on the ${action.on} it acts on`,
      );
    const steps = type.steps(settings, ANY_ITEM);
    const decide = steps.findIndex((p) => p.kind === "decision");
    const act = steps.findIndex((p) => p.kind !== "decision");
    if (decide < 0 || (act >= 0 && decide > act))
      err("F6", inst.id, `${inst.name} must decide before it acts`);
    if (action.risk === "merge") {
      // F8: nothing reaches a default branch except through checks on that head.
      let ok = false;
      for (let i = index - 1; i >= 0; i--) {
        const earlier = stages[i];
        if (!earlier) break;
        if (earlier.type.id === "checks") {
          // F7: the Checks stage F8 relies on can't be conditional, or a workflow could skip
          // checks for some items (small ones, say) and still pass F8.
          if (earlier.inst.when)
            err(
              "F7",
              earlier.inst.id,
              `${earlier.inst.name} can't be skipped: ${inst.name} merges only after it`,
            );
          ok = true;
          break;
        }
        if (earlier.type.produces.includes("git-head")) break;
      }
      if (!ok)
        err(
          "F8",
          inst.id,
          `${inst.name} merges, so a Checks stage must come after the last build before it`,
        );
    }
  });

  // F9: what the stages need exists.
  for (const { inst, type, settings } of stages) {
    const req = type.requires(settings);
    for (const c of req.connectors)
      if (!KNOWN_CONNECTORS.includes(c)) err("F9", inst.id, `the factory has no ${c} connector`);
    for (const c of req.capabilities)
      if (!(CAPABILITIES as readonly string[]).includes(c))
        err("F9", inst.id, `unknown capability ${c}`);
    if (req.repository && opts.hasRepository === false)
      err("F9", inst.id, `${inst.name} needs a repository, and the project has none`);
  }

  if (errors.length > 0) return { valid: false, errors };
  const filled = new Map(stages.map((s) => [s.inst.id, s.settings]));
  return {
    valid: true,
    errors: [],
    definition: { ...def, stages: def.stages.map((s) => ({ ...s, settings: filled.get(s.id) })) },
  };
}
