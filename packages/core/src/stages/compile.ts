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
import { SOFTWARE } from "./builtins.ts";
import type { Size } from "./contract.ts";
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
      id: s.id,
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
