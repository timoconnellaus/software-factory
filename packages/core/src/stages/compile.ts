// Today's per-project slot workflows (ADR 0371) expressed as stage lists (spec 52, "Migration"),
// and the plan the engine would make from one. Build plan PR (a): nothing at run time uses these;
// tests check that `planFromDefinition(compileProjectWorkflow(…))` is the engine's `planWorkflow()`.
import { DEFAULT_BUILDER } from "../improve.ts";
import {
  type ProjectPolicy,
  SLOTS,
  type SlotName,
  type StepConfig,
} from "../policy/project-policy.ts";
import { ATTACHED_PR, SOFTWARE } from "./builtins.ts";
import { SIZE_RANK, type Size } from "./contract.ts";
import { conditionHolds } from "./settings.ts";
import { FIXED_STATES, type StageInstance, type WorkflowDefinition } from "./workflow.ts";

/** Where each slot sits in the Software stage list: after this stage. */
const SLOT_AFTER: Record<SlotName, string> = {
  afterSpec: "spec",
  beforeVerify: "build",
  afterVerify: "verify",
};

const RESERVED = new Set<string>([...SOFTWARE.stages.map((s) => s.id), ...FIXED_STATES]);

/**
 * The stage id for a slot step: its own id, unless that is one of Software's stage ids or a fixed
 * state, which it can't take (rule S2); then `step-` plus the id.
 */
export function slotStageId(stepId: string): string {
  return RESERVED.has(stepId) ? `step-${stepId}`.slice(0, 40) : stepId;
}

/** The slot step's own id back from its stage id (the reverse of `slotStageId`). */
function slotStepId(stageId: string): string {
  const bare = stageId.slice("step-".length);
  return stageId.startsWith("step-") && RESERVED.has(bare) ? bare : stageId;
}

/** Thrown when a project's slot workflow can't be expressed as a valid stage list. */
export class CompileError extends Error {
  override readonly name = "CompileError";
}

function slotStage(step: StepConfig): StageInstance {
  if (step.kind === "work") {
    return {
      id: slotStageId(step.id),
      type: "agent-check",
      typeVersion: 1,
      name: step.name,
      phase: "delivery",
      settings: { instructions: step.instructions },
      ...(step.when ? { when: step.when } : {}),
      ...(step.agent ? { agent: step.agent } : {}),
    };
  }
  return {
    id: slotStageId(step.id),
    type: "decision",
    typeVersion: 1,
    name: step.name,
    phase: "delivery",
    // A gate step's condition is the decision's typed setting, so the gate is conditional (F7).
    settings: {
      decider: step.approver ? { person: step.approver } : "approvers",
      instructions: step.instructions,
      ...(step.when ? { when: step.when } : {}),
    },
  };
}

/**
 * A project's workflow (by name, ADR 0492; null for the skeleton alone) as a definition: the Software
 * stages with the project's settings, and the slot steps as `agent-check` and `decision` stages.
 */
export function compileProjectWorkflow(
  policy: ProjectPolicy,
  workflow: string | null,
): WorkflowDefinition {
  const def = workflow
    ? policy.workflows.find((w) => w.name.toLowerCase() === workflow.toLowerCase())
    : undefined;
  const settingsFor: Record<string, Record<string, unknown>> = {
    spec: { requiredFrom: policy.spec.requiredFrom },
    build: { retryLimit: policy.retryLimit },
    verify: {
      requiredChecks: [...policy.protection.requiredChecks],
      ...(policy.reviewPacket ? { sections: [...policy.reviewPacket.sections] } : {}),
    },
  };
  const builder = def?.core.build ?? DEFAULT_BUILDER;
  const hasBuilder = policy.agents.some(
    (a) => a.name.toLowerCase() === builder.toLowerCase() && a.role === "implement",
  );
  // Two slot steps whose ids map to the same stage id ("build" and "step-build") would compile to a
  // definition that fails S2. Refuse here, naming both, rather than hand back an invalid one.
  const seen = new Map<string, string>();
  for (const slot of SLOTS)
    for (const step of def?.slots[slot] ?? []) {
      const id = slotStageId(step.id);
      const other = seen.get(id);
      if (other !== undefined)
        throw new CompileError(
          `workflow "${def?.name}": slot steps "${other}" and "${step.id}" both become stage "${id}"; rename one`,
        );
      seen.set(id, step.id);
    }
  const stages: StageInstance[] = [];
  for (const base of SOFTWARE.stages) {
    stages.push({
      ...base,
      settings: { ...(base.settings as object), ...(settingsFor[base.id] ?? {}) },
      ...(base.id === "build" && hasBuilder ? { agent: builder } : {}),
    });
    for (const slot of SLOTS) {
      if (SLOT_AFTER[slot] !== base.id) continue;
      for (const step of def?.slots[slot] ?? []) stages.push(slotStage(step));
    }
  }
  return {
    schema: 1,
    id: def ? `wf_${slug(def.name)}` : SOFTWARE.id,
    name: def?.name ?? SOFTWARE.name,
    description: def?.description ?? SOFTWARE.description,
    template: { id: SOFTWARE.id, version: 1 },
    stages,
  };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "workflow"
  );
}

export interface PlannedAgent {
  name: string;
  role: string;
  tier: "standard" | "light";
  instructions: string;
  requires: string[];
}

export interface PlannedStep {
  id: string;
  kind: "work" | "gate";
  name: string;
  instructions: string;
  approver?: string;
  agent?: PlannedAgent;
  skip?: string;
}

/** The engine's `WorkflowPlan` shape (Workflow v6+), made from a definition. */
export interface DefinitionPlan {
  name: string | null;
  slots: Record<SlotName, PlannedStep[]>;
  build: PlannedAgent | null;
}

/**
 * The plan the engine makes before build, from a Software-shaped definition: the stages between
 * spec and build, build and verify, verify and merge are the three slots. Pure.
 */
export function planFromDefinition(
  def: WorkflowDefinition,
  agents: ProjectPolicy["agents"],
  size: Size | null,
  domains: readonly string[],
  /** The plan's name: null when the project runs the skeleton alone. */
  name: string | null,
): DefinitionPlan {
  const agentOf = (n: string | undefined): PlannedAgent | null => {
    const a = n ? agents.find((x) => x.name.toLowerCase() === n.toLowerCase()) : undefined;
    return a
      ? {
          name: a.name,
          role: a.role,
          tier: a.tier,
          instructions: a.instructions,
          requires: [...a.requires],
        }
      : null;
  };
  const slots: Record<SlotName, PlannedStep[]> = {
    afterSpec: [],
    beforeVerify: [],
    afterVerify: [],
  };
  let slot: SlotName | null = null;
  let build: PlannedAgent | null = null;
  for (const s of def.stages) {
    const after = (Object.keys(SLOT_AFTER) as SlotName[]).find((k) => SLOT_AFTER[k] === s.id);
    if (after) {
      slot = after;
      if (s.id === "build") build = agentOf(s.agent);
      continue;
    }
    if (s.type !== "agent-check" && s.type !== "decision") {
      slot = null;
      if (s.id === "build") build = agentOf(s.agent);
      continue;
    }
    if (!slot) continue;
    const settings = s.settings as {
      instructions?: string;
      decider?: "approvers" | { person: string };
      when?: StageInstance["when"];
    };
    const when = s.type === "decision" ? settings.when : s.when;
    const cond = conditionHolds(when, size, domains);
    const agent = s.type === "agent-check" ? agentOf(s.agent) : null;
    const decider = settings.decider;
    slots[slot].push({
      id: slotStepId(s.id),
      kind: s.type === "agent-check" ? "work" : "gate",
      name: s.name,
      instructions: settings.instructions ?? "",
      ...(decider && decider !== "approvers" ? { approver: decider.person } : {}),
      ...(agent ? { agent } : {}),
      ...(cond.holds ? {} : { skip: cond.why }),
    });
  }
  return { name, slots, build };
}

/**
 * The definition an item of this kind runs, as today's engine runs it: an attached PR the built-in
 * Attached PR workflow (chosen by kind); an incident's fix the project's workflow with every stage in
 * delivery (it is opened queued, never shaped); anything else the project's workflow.
 */
export function compileItemWorkflow(
  policy: ProjectPolicy,
  workflow: string | null,
  kind: "change" | "incident" | "attached",
): WorkflowDefinition {
  if (kind === "attached") return ATTACHED_PR;
  const def = compileProjectWorkflow(policy, workflow);
  if (kind === "change") return def;
  return { ...def, stages: def.stages.map((s) => ({ ...s, phase: "delivery" as const })) };
}

/**
 * Whether the definition's spec gate holds for an item: its `interview-planning` stage's condition
 * (`requiredFrom`; large always), or the foreman asked for one. No such stage: no spec. Pure.
 */
export function specGateHolds(
  def: WorkflowDefinition,
  size: Size,
  requested?: "skip" | "require",
): boolean {
  const stage = def.stages.find((s) => s.type === "interview-planning");
  if (!stage) return false;
  const from = (stage.settings as { requiredFrom?: Size }).requiredFrom ?? "medium";
  if (size === "large" || SIZE_RANK[size] >= SIZE_RANK[from]) return true;
  return requested === "require";
}

/** Today's engine stages (`core_stages.stage`) a Software-shaped definition's stages stand for. */
const ENGINE_STAGES = ["triage", "spec", "build", "verify", "merge"] as const;
export type EngineStage = (typeof ENGINE_STAGES)[number];

/**
 * The engine stages an item passes through under a definition, in order, with whether each runs or
 * is skipped and its phase. Slot stages show inside the stage before them, so they aren't listed.
 */
export function engineStages(
  def: WorkflowDefinition,
  size: Size,
  requested?: "skip" | "require",
): { stage: EngineStage; runs: boolean; phase: "shaping" | "delivery" | null }[] {
  return ENGINE_STAGES.map((stage) => {
    const inst = def.stages.find((s) => s.id === stage);
    const runs = !!inst && (stage !== "spec" || specGateHolds(def, size, requested));
    return { stage, runs, phase: inst?.phase ?? null };
  });
}
