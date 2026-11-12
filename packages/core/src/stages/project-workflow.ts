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
  type AgentConfig,
  onOrgWorkflow,
  type ProjectPolicy,
  type SlotName,
  type StepConfig,
  type WorkflowConfig,
} from "../policy/project-policy.ts";
import { SOFTWARE } from "./builtins.ts";
import { compileProjectWorkflow, slotStepId } from "./compile.ts";
import { type AnyStageType, SIZE_RANK, type Size } from "./contract.ts";
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

export type OverrideApprovals = ProjectPolicy["workflowOverrideApprovals"];

/**
 * How overrides apply. `requested`: each as the project wrote it (what a save asks for, so it is
 * classified against what applies now). `effective`: what an item runs, the stricter of the org's
 * value and the override, unless the override was approved as a loosening against the org's current
 * value (`approvals`).
 */
export type OverrideMode =
  | { kind: "requested" }
  | { kind: "effective"; approvals: OverrideApprovals };

/**
 * The stricter of the org's value and a project's override, per overridable setting (spec 52, Q5,
 * fourth review): more items get a spec, every required check of either, every review section of
 * either. A setting whose direction isn't policy (`retryLimit`) takes the override. Unknown
 * settings take the org's value.
 */
function stricterOf(key: string, org: unknown, override: unknown): unknown {
  if (key === "requiredFrom")
    return SIZE_RANK[override as Size] < SIZE_RANK[org as Size] ? override : org;
  if (key === "requiredChecks")
    return [...new Set([...((override as string[]) ?? []), ...((org as string[]) ?? [])])];
  if (key === "sections") {
    // No list means every section.
    if (org === undefined || override === undefined) return undefined;
    return [...new Set([...(override as string[]), ...(org as string[])])];
  }
  if (key === "retryLimit") return override;
  return org;
}

/** Whether `override` in place of the org's `value` for `key` loosens, by the type's own rules. */
export function overrideLoosens(
  type: AnyStageType,
  settings: unknown,
  key: string,
  override: unknown,
): boolean {
  const before = type.settings.safeParse(settings ?? {});
  const after = type.settings.safeParse({ ...(settings as object), [key]: override });
  if (!before.success || !after.success) return true;
  return type.impact(before.data, after.data, "s").some((c) => c.class === "loosens");
}

/** The definition with a project's overrides applied: only `overridable` settings, each valid. */
export function applyOverrides(
  def: WorkflowDefinition,
  overrides: WorkflowOverrides,
  mode: OverrideMode = { kind: "requested" },
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
    const orgSettings = (type?.settings.safeParse(stage.settings ?? {}) ?? { success: false }) as
      | { success: true; data: Record<string, unknown> }
      | { success: false };
    let applied: Record<string, unknown> = { ...(stage.settings as object), ...values };
    if (mode.kind === "effective" && type && orgSettings.success) {
      applied = { ...(stage.settings as object) };
      for (const [key, value] of Object.entries(values)) {
        const orgValue = orgSettings.data[key];
        const approval = mode.approvals[stageId]?.[key];
        const approved = approval !== undefined && same(approval.orgValue, orgValue);
        if (approved || !overrideLoosens(type, stage.settings, key, value)) applied[key] = value;
        else {
          const merged = stricterOf(key, orgValue, value);
          // Fail closed: a merge the type still calls looser than the org's value isn't used.
          applied[key] = overrideLoosens(type, stage.settings, key, merged) ? orgValue : merged;
        }
        if (applied[key] === undefined) delete applied[key];
      }
    }
    const parsed = type?.settings.safeParse(applied);
    if (!parsed?.success)
      return {
        ok: false,
        error: `${stage.name}'s override isn't valid: ${parsed?.error.issues[0]?.message ?? "unknown type"}`,
      };
    stage.settings = applied;
  }
  return { ok: true, value: { ...def, stages } };
}

/**
 * The overrides a save stores (spec 52, fourth review): only what differs from the org workflow's
 * value, so a tightening the org makes later reaches the project; and, for each override looser
 * than the org's value, its approval. `approve` (an approved loosening save) stamps every looser
 * override with the org version and value it was approved against; otherwise an approval carries
 * over only for an override the save leaves as it was.
 */
export function normaliseOverrides(
  policy: ProjectPolicy,
  org: OrgConfig,
  orgVersion: number,
  previous: ProjectPolicy | null,
  approve: boolean,
): { workflowOverrides: WorkflowOverrides; workflowOverrideApprovals: OverrideApprovals } {
  const empty = { workflowOverrides: {}, workflowOverrideApprovals: {} };
  if (!onOrgWorkflow(policy)) return empty;
  const def = projectWorkflowById(org, policy.workflow);
  if (!def) return empty;
  const overrides: WorkflowOverrides = {};
  const approvals: OverrideApprovals = {};
  const carried = previous && previous.workflow === policy.workflow ? previous : null;
  for (const [stageId, values] of Object.entries(policy.workflowOverrides)) {
    const stage = def.stages.find((s) => s.id === stageId);
    const type = stage ? stageType(stage.type) : undefined;
    const parsed = stage && type ? type.settings.safeParse(stage.settings ?? {}) : null;
    for (const [key, value] of Object.entries(values)) {
      const orgValue = parsed?.success ? (parsed.data as Record<string, unknown>)[key] : undefined;
      if (parsed?.success && same(orgValue, value)) continue;
      overrides[stageId] = { ...overrides[stageId], [key]: value };
      if (!stage || !type || !overrideLoosens(type, stage.settings, key, value)) continue;
      const before = carried?.workflowOverrideApprovals[stageId]?.[key];
      const unchanged = same(carried?.workflowOverrides[stageId]?.[key], value);
      const approval = approve
        ? { orgVersion, orgValue }
        : unchanged && before
          ? before
          : undefined;
      if (approval) approvals[stageId] = { ...approvals[stageId], [key]: approval };
    }
  }
  return { workflowOverrides: overrides, workflowOverrideApprovals: approvals };
}

/**
 * The project's approved loosening overrides that `org` no longer honours: the org moved the value
 * an override was approved against, and the override is still looser than the new one. Each lapses
 * (the stricter value applies) and the org's admins are told.
 */
export function lapsedOverrides(
  policy: ProjectPolicy,
  org: OrgConfig,
): { stageId: string; key: string }[] {
  if (!onOrgWorkflow(policy)) return [];
  const def = projectWorkflowById(org, policy.workflow);
  if (!def) return [];
  const out: { stageId: string; key: string }[] = [];
  for (const [stageId, keys] of Object.entries(policy.workflowOverrideApprovals)) {
    const stage = def.stages.find((s) => s.id === stageId);
    const type = stage ? stageType(stage.type) : undefined;
    const parsed = stage && type ? type.settings.safeParse(stage.settings ?? {}) : null;
    for (const [key, approval] of Object.entries(keys)) {
      const value = policy.workflowOverrides[stageId]?.[key];
      if (value === undefined || !stage || !type || !parsed?.success) continue;
      const orgValue = (parsed.data as Record<string, unknown>)[key];
      if (same(approval.orgValue, orgValue)) continue;
      if (overrideLoosens(type, stage.settings, key, value)) out.push({ stageId, key });
    }
  }
  return out;
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
  const later =
    "the factory can only run workflows shaped like Software until the reconciler takes over";
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

/**
 * The org workflow a project runs, with its overrides; why not, if it can't run it. `mode` defaults
 * to what an item runs (`effective`, with the project's approvals).
 */
export function resolveProjectWorkflow(
  policy: ProjectPolicy,
  org: OrgConfig,
  mode: OverrideMode = { kind: "effective", approvals: policy.workflowOverrideApprovals },
): Result<WorkflowDefinition> | null {
  if (!onOrgWorkflow(policy)) return null;
  const base = projectWorkflowById(org, policy.workflow);
  if (!base) return { ok: false, error: `the org has no workflow ${policy.workflow}` };
  const applied = applyOverrides(base, policy.workflowOverrides, mode);
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
      workflowOverrideApprovals: {},
    },
  };
}

/** The definition a project's config runs: its org workflow resolved, else its slot workflow. */
function definitionOf(
  policy: ProjectPolicy,
  org: OrgConfig,
  mode?: OverrideMode,
): WorkflowDefinition | null {
  const resolved = resolveProjectWorkflow(policy, org, mode);
  if (!resolved) return compileProjectWorkflow(policy, policy.workflow);
  return resolved.ok ? resolved.value : null;
}

/** The agents a config's workflow hands to: the org's on an org workflow, else the project's. */
function agentsOf(policy: ProjectPolicy, org: OrgConfig): AgentConfig[] {
  return onOrgWorkflow(policy) ? org.agents : policy.agents;
}

/**
 * `policyImpact` with the org workflow in view: a change of the project's workflow or overrides is
 * classified by comparing the definitions it runs before and after (spec 52: "A project override
 * that loosens against the org workflow's value loosens"; switching workflows compares the two, ADR
 * 0492 §3), instead of `policyImpact`'s fail-closed placeholder. `before` is what runs now (its
 * overrides as they apply, approvals and all); `after` is what the save asks for (its overrides as
 * written), so an override that applies only once approved is classified as the loosening it is. A
 * judging stage is compared by what its agent is told (the agent's definition), not by its name, so
 * a same-named org agent that passes everything isn't the project's judge (Q16).
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
  const now = definitionOf(after, org, { kind: "requested" });
  if (!was || !now) {
    changes.push({
      path: "workflow",
      class: "loosens",
      summary:
        "The project's workflow can't be resolved against the org's, so it can't be compared.",
    });
    return summarise(changes);
  }
  // Stage by stage: which workflow it is (id, name, template) is the switch below, not a change of
  // the workflow's identity, which workflowImpact would fail closed on.
  const asWas = {
    ...now,
    id: was.id,
    name: was.name,
    description: was.description,
    template: was.template,
  };
  const agents = { before: agentsOf(before, org), after: agentsOf(after, org) };
  for (const c of workflowImpact(was, asWas, agents).changes)
    changes.push({ ...c, path: `workflow.${c.path}` });
  if (!same(before.workflow, after.workflow) && (was.id !== now.id || was.name !== now.name))
    changes.push({
      path: "workflow",
      class: "neutral",
      summary: `The project's workflow: ${was.name} → ${now.name}.`,
    });
  return summarise(changes);
}
