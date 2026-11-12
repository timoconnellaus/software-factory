// A project on an org workflow (spec 52 PR (d)). A project's config names an org workflow by id
// (`workflow: "wf_…"`) and may override a short, fixed list of its stage settings
// (`workflowOverrides`, Q5). Until the switch-over to the reconciler, today's replayed Workflow runs
// the project, so the org workflow must be one it can run: Software's stages, in order, with agent
// checks and decisions in its three slots and only the settings it reads changed. `effectivePolicy`
// turns such a project's config into the config today's engine reads, so nothing downstream changes.
import {
  type ImpactChange,
  ORG_WORKFLOW_UNRESOLVED,
  type PolicyImpact,
  same,
} from "../policy/impact.ts";
import {
  isOrgWorkflowId,
  type ProjectPolicy,
  type SlotName,
  type StepConfig,
  type WorkflowConfig,
} from "../policy/project-policy.ts";
import { SOFTWARE } from "./builtins.ts";
import { compileProjectWorkflow, slotStepId } from "./compile.ts";
import { summarise, workflowImpact } from "./impact.ts";
import type { OrgConfig } from "./org-config.ts";
import { stageType } from "./registry.ts";
import type { Condition } from "./settings.ts";
import type { StageInstance, WorkflowDefinition } from "./workflow.ts";

export type WorkflowOverrides = ProjectPolicy["workflowOverrides"];

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The workflow a project may run by id: one of the org's, or Software itself. Incident and Attached
 * PR are chosen by an item's kind, never by a project.
 */
export function projectWorkflowById(org: OrgConfig, id: string): WorkflowDefinition | null {
  if (id === SOFTWARE.id) return SOFTWARE;
  return org.workflows.find((w) => w.id === id) ?? null;
}

/** The definition with a project's overrides applied: only `overridable` settings, each valid. */
export function applyOverrides(
  def: WorkflowDefinition,
  overrides: WorkflowOverrides,
): Result<WorkflowDefinition> {
  const stages = def.stages.map((s) => ({ ...s }));
  for (const [stageId, values] of Object.entries(overrides)) {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) return { ok: false, error: `${def.name} has no stage "${stageId}" to override` };
    const type = stageType(stage.type);
    const allowed = type?.overridable ?? [];
    for (const key of Object.keys(values))
      if (!allowed.includes(key))
        return {
          ok: false,
          error: `a project can't override ${stage.name}'s ${key}${allowed.length ? ` (only ${allowed.join(", ")})` : ""}`,
        };
    const settings = { ...(stage.settings as object), ...values };
    const parsed = type?.settings.safeParse(settings);
    if (!parsed?.success)
      return {
        ok: false,
        error: `${stage.name}'s override isn't valid: ${parsed?.error.issues[0]?.message ?? "unknown type"}`,
      };
    stage.settings = settings;
  }
  return { ok: true, value: { ...def, stages } };
}

const SLOT_AFTER: Record<string, SlotName> = {
  spec: "afterSpec",
  build: "beforeVerify",
  verify: "afterVerify",
};

/** The settings today's engine reads from each Software stage; any other must keep its default. */
const READ_TODAY: Record<string, readonly string[]> = {
  triage: [],
  spec: ["requiredFrom"],
  build: ["retryLimit"],
  verify: ["requiredChecks", "sections"],
  merge: [],
};

/**
 * Why today's replayed Workflow can't run `def` as written, or null when it can: Software's five
 * stages in order with their types and phases, agent checks and decisions only in the three slots,
 * and nothing else changed that the engine would silently ignore. Anything more waits for the
 * reconciler's switch-over.
 */
export function runsOnToday(def: WorkflowDefinition): string | null {
  const later = "today's engine can't run it until the switch-over to the reconciler";
  const core = def.stages.filter((s) => s.type !== "agent-check" && s.type !== "decision");
  const want = SOFTWARE.stages;
  if (
    core.length !== want.length ||
    core.some((s, i) => s.id !== want[i]?.id || s.type !== want[i]?.type)
  )
    return `${def.name} isn't Software's stages in order (${want.map((s) => s.id).join(", ")}): ${later}`;
  let slot: SlotName | null = null;
  for (const s of def.stages) {
    const base = want.find((w) => w.id === s.id);
    if (base) {
      slot = SLOT_AFTER[s.id] ?? null;
      if (s.phase !== base.phase) return `${s.name} runs in ${s.phase}: ${later}`;
      if (s.when) return `${s.name} has a condition: ${later}`;
      if (s.agent && s.id !== "build") return `${s.name} names an agent: ${later}`;
      const type = stageType(s.type);
      const parsed = type?.settings.safeParse(s.settings ?? {});
      const defaults = type?.settings.safeParse({});
      if (!parsed?.success || !defaults?.success) return `${s.name}'s settings aren't valid`;
      const now = parsed.data as Record<string, unknown>;
      const dflt = defaults.data as Record<string, unknown>;
      for (const key of new Set([...Object.keys(now), ...Object.keys(dflt)]))
        if (!READ_TODAY[s.id]?.includes(key) && !same(now[key], dflt[key]))
          return `${s.name}'s ${key} isn't the default: ${later}`;
      continue;
    }
    if (!slot) return `${s.name} isn't in one of Software's slots: ${later}`;
    if (s.phase !== "delivery") return `${s.name} runs in ${s.phase}: ${later}`;
  }
  return null;
}

/** A Software-shaped definition's slot stages as today's slot workflow (the reverse of compile). */
function slotWorkflow(def: WorkflowDefinition): WorkflowConfig {
  const slots: WorkflowConfig["slots"] = { afterSpec: [], beforeVerify: [], afterVerify: [] };
  let slot: SlotName | null = null;
  let build: string | undefined;
  for (const s of def.stages) {
    if (s.id === "build") build = s.agent;
    if (SOFTWARE.stages.some((w) => w.id === s.id)) {
      slot = SLOT_AFTER[s.id] ?? null;
      continue;
    }
    if (!slot) continue;
    const settings = s.settings as {
      instructions?: string;
      decider?: "approvers" | { person: string };
      when?: Condition;
    };
    const when = s.type === "decision" ? settings.when : s.when;
    const step: StepConfig = {
      id: slotStepId(s.id),
      kind: s.type === "agent-check" ? "work" : "gate",
      name: s.name,
      instructions: settings.instructions ?? "",
      ...(s.type === "agent-check" && s.agent ? { agent: s.agent } : {}),
      ...(settings.decider && settings.decider !== "approvers"
        ? { approver: settings.decider.person }
        : {}),
      ...(when ? { when } : {}),
    };
    slots[slot].push(step);
  }
  // The workflow is named by its id: the item pins `workflow` as the project names it (ADR 0492).
  return {
    name: def.id,
    description: def.name,
    slots,
    core: build ? { build } : {},
  };
}

/** The org workflow a project runs, with its overrides; why not, if it can't run it. */
export function resolveProjectWorkflow(
  policy: ProjectPolicy,
  org: OrgConfig,
): Result<WorkflowDefinition> | null {
  if (!isOrgWorkflowId(policy.workflow)) return null;
  const base = projectWorkflowById(org, policy.workflow);
  if (!base) return { ok: false, error: `the org has no workflow ${policy.workflow}` };
  const applied = applyOverrides(base, policy.workflowOverrides);
  if (!applied.ok) return applied;
  const why = runsOnToday(applied.value);
  return why ? { ok: false, error: why } : applied;
}

/**
 * The config today's engine reads for a project on an org workflow: the org workflow (with the
 * project's overrides) as its one slot workflow, the org's agents, and the stage settings the engine
 * reads (`spec.requiredFrom`, `retryLimit`, `protection.requiredChecks`, `reviewPacket.sections`)
 * from the definition. Everything else (autonomy, approvers, limits, the harness) stays the
 * project's. A project not on an org workflow is returned as it is.
 */
export function effectivePolicy(policy: ProjectPolicy, org: OrgConfig): Result<ProjectPolicy> {
  const resolved = resolveProjectWorkflow(policy, org);
  if (!resolved) return { ok: true, value: policy };
  if (!resolved.ok) return resolved;
  const def = resolved.value;
  const settings = (id: string) => {
    const s = def.stages.find((x) => x.id === id) as StageInstance;
    return stageType(s.type)?.settings.parse(s.settings ?? {}) as Record<string, unknown>;
  };
  const spec = settings("spec") as { requiredFrom: ProjectPolicy["spec"]["requiredFrom"] };
  const build = settings("build") as { retryLimit: number };
  const verify = settings("verify") as { requiredChecks: string[]; sections?: string[] };
  const workflow = slotWorkflow(def);
  const { reviewPacket: _drop, ...rest } = policy;
  return {
    ok: true,
    value: {
      ...rest,
      spec: { ...policy.spec, requiredFrom: spec.requiredFrom },
      retryLimit: build.retryLimit,
      protection: { ...policy.protection, requiredChecks: [...verify.requiredChecks] },
      ...(verify.sections ? { reviewPacket: { sections: [...verify.sections] } } : {}),
      agents: org.agents.map((a) => ({ ...a, requires: [...a.requires] })),
      workflows: [workflow],
      workflow: workflow.name,
      workflowOverrides: {},
    },
  };
}

/** The definition a project's config runs: its org workflow resolved, else its slot workflow. */
function definitionOf(policy: ProjectPolicy, org: OrgConfig): WorkflowDefinition | null {
  const resolved = resolveProjectWorkflow(policy, org);
  if (!resolved) return compileProjectWorkflow(policy, policy.workflow);
  return resolved.ok ? resolved.value : null;
}

/**
 * `policyImpact` with the org workflow in view: a change of the project's workflow or overrides is
 * classified by comparing the definitions it runs before and after (spec 52: "A project override
 * that loosens against the org workflow's value loosens"; switching workflows compares the two, ADR
 * 0492 §3), instead of `policyImpact`'s fail-closed placeholder. The agent judging slot steps of a
 * project moving onto an org workflow is the org's: its classification is the org's (Q16).
 */
export function configImpact(
  impact: PolicyImpact,
  before: ProjectPolicy,
  after: ProjectPolicy,
  org: OrgConfig,
): PolicyImpact {
  if (!impact.changes.some((c) => c.summary === ORG_WORKFLOW_UNRESOLVED)) return impact;
  const changes: ImpactChange[] = impact.changes.filter(
    (c) => c.summary !== ORG_WORKFLOW_UNRESOLVED,
  );
  const was = definitionOf(before, org);
  const now = definitionOf(after, org);
  if (!was || !now) {
    changes.push({
      path: "workflow",
      class: "loosens",
      summary:
        "The project's workflow can't be resolved against the org's, so it can't be compared.",
    });
    return summarise(changes);
  }
  // Agents differ between a project's slot workflow and the org's: a different judge loosens
  // (workflowImpact's agent rule), and a different builder is practice.
  // Stage by stage: which workflow it is (id, name, template) is the switch below, not a change of
  // the workflow's identity, which workflowImpact would fail closed on.
  const asWas = {
    ...now,
    id: was.id,
    name: was.name,
    description: was.description,
    template: was.template,
  };
  for (const c of workflowImpact(was, asWas).changes)
    changes.push({ ...c, path: `workflow.${c.path}` });
  if (!same(before.workflow, after.workflow) && (was.id !== now.id || was.name !== now.name))
    changes.push({
      path: "workflow",
      class: "neutral",
      summary: `The project's workflow: ${was.name} → ${now.name}.`,
    });
  return summarise(changes);
}
