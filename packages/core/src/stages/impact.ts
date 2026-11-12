// `workflowImpact`: a workflow change classified as loosens, tightens or neutral (spec 52, "The
// impact check"), extending ADR 0370's `policyImpact`.
//
// The classifier is an allow-list (ADR 0516): a change is neutral or tightening only when a rule
// below (or the stage type's own `impact()`) says so. Anything else, including a setting a type's
// `impact()` says nothing about, a type version it can't migrate, a reordered stage and a field
// this code doesn't know, is a loosening, so a person decides it.
import { type ImpactChange, type PolicyImpact, same } from "../policy/impact.ts";
import type { AgentConfig } from "../policy/project-policy.ts";
import type { AnyStageType } from "./contract.ts";
import { stageType } from "./registry.ts";
import { conditionImpact } from "./settings.ts";
import type { StageInstance, WorkflowDefinition } from "./workflow.ts";

/** A stage that checks or gates: removing it, skipping it or moving it weakens what is seen. */
export function guards(type: AnyStageType | undefined, settings: unknown): boolean {
  if (!type) return true;
  if (type.id === "checks" || type.id === "agent-check") return true;
  const parsed = parse(type, settings);
  return parsed === null || type.gate(parsed) !== null;
}

/** The settings with defaults filled; null when they don't parse (then nothing is classified). */
function parse(type: AnyStageType, settings: unknown): unknown | null {
  const parsed = type.settings.safeParse(settings ?? {});
  return parsed.success ? parsed.data : null;
}

/**
 * Whether a stage does anything outside the factory: an irreversible action (merge, publish, deploy)
 * or a reversible outward write (opening a PR, a preview deploy). Adding one is an action gained.
 */
export function actsOutside(type: AnyStageType, settings: unknown): boolean {
  if (type.reversibility !== "internal") return true;
  const parsed = parse(type, settings);
  return parsed === null || type.action?.(parsed) !== undefined;
}

/**
 * True when `stage` takes no outside action of its own in `workflow`: it has no irreversible action,
 * and everything it produces outside (a pull request) an earlier stage already produces, so it works
 * on that one instead of opening another.
 */
function checksExisting(type: AnyStageType, stage: StageInstance, workflow: WorkflowDefinition) {
  if (type.reversibility !== "reversible-outside") return false;
  const parsed = parse(type, stage.settings);
  if (parsed === null || type.action?.(parsed) !== undefined) return false;
  const earlier = new Set<string>();
  for (const s of workflow.stages) {
    if (s.id === stage.id) break;
    // A producer that runs only for some items leaves the rest without one: this stage would open it.
    if (s.when) continue;
    for (const kind of stageType(s.type)?.produces ?? []) earlier.add(kind);
  }
  return type.produces.length > 0 && type.produces.every((kind) => earlier.has(kind));
}

const loosens = (path: string, summary: string): ImpactChange => ({
  path,
  class: "loosens",
  summary,
});

/** Settings saved under `from`, in the type's current shape; null when they can't be. */
function migrated(type: AnyStageType, settings: unknown, from: number, to: number): unknown | null {
  if (from === to) return settings;
  if (to !== type.version || !type.migrate) return null;
  try {
    return type.migrate(settings, from);
  } catch {
    return null;
  }
}

function settingsImpact(
  type: AnyStageType,
  before: StageInstance,
  after: StageInstance,
): ImpactChange[] {
  const at = `stages.${after.id}`;
  const rawBefore = migrated(type, before.settings, before.typeVersion, after.typeVersion);
  if (rawBefore === null)
    return [
      loosens(
        `${at}.typeVersion`,
        `${after.name} moves from version ${before.typeVersion} to ${after.typeVersion} of ${type.id}, which can't be compared.`,
      ),
    ];
  const b = parse(type, rawBefore);
  const a = parse(type, after.settings);
  if (b === null || a === null)
    return [loosens(`${at}.settings`, `${after.name}'s settings changed.`)];
  const out = [...type.impact(b, a, at)];
  if (before.typeVersion !== after.typeVersion)
    out.push({
      path: `${at}.typeVersion`,
      class: "neutral",
      summary: `${after.name} moves to version ${after.typeVersion} of its type.`,
    });
  // Allow-list: a setting that differs and that the type's impact() said nothing about loosens.
  const bo = b as Record<string, unknown>;
  const ao = a as Record<string, unknown>;
  for (const key of new Set([...Object.keys(bo), ...Object.keys(ao)])) {
    if (same(bo[key], ao[key])) continue;
    const path = `${at}.${key}`;
    if (!out.some((c) => c.path === path || c.path.startsWith(`${path}.`)))
      out.push(
        loosens(path, `${after.name}'s ${key} changed in a way the factory can't classify.`),
      );
  }
  return out;
}

/**
 * The agents each side's stages hand to, when the two sides draw on different agent lists (a project
 * moving from its own slot workflow to an org workflow). Then a judging stage is compared by what
 * its agent is (role, tier, instructions, requirements), not by its name.
 */
export interface ImpactAgents {
  before: readonly AgentConfig[];
  after: readonly AgentConfig[];
}

/** The judging agent's definition without its name; `missing` when there's no such agent. */
function judgeBody(agents: readonly AgentConfig[], name: string | undefined): unknown {
  if (!name) return { builtIn: true };
  const a = agents.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!a) return { missing: name.toLowerCase() };
  return {
    role: a.role,
    tier: a.tier,
    instructions: a.instructions,
    requires: [...a.requires].sort(),
  };
}

function stageImpact(
  before: StageInstance,
  after: StageInstance,
  agents?: ImpactAgents,
): ImpactChange[] {
  const at = `stages.${after.id}`;
  if (before.type !== after.type)
    return [loosens(at, `${after.name} changes from ${before.type} to ${after.type}.`)];
  const type = stageType(after.type);
  if (!type) return same(before, after) ? [] : [loosens(at, `${after.name} changed.`)];
  const out = settingsImpact(type, before, after);
  if (!same(before.when, after.when)) {
    // A condition on a check or a gate: conditionImpact's rules. On any other stage the effect on
    // what is checked downstream isn't known (a skipped triage leaves items unsized): loosens.
    if (guards(type, after.settings) && guards(type, before.settings))
      out.push(...conditionImpact(`${at}.when`, before.when, after.when));
    else out.push(loosens(`${at}.when`, `${after.name} runs for different items.`));
  }
  if (before.phase !== after.phase)
    out.push(loosens(`${at}.phase`, `${after.name} moves from ${before.phase} to ${after.phase}.`));
  const judgeChanged =
    type.judges === "agent" && agents
      ? !same(judgeBody(agents.before, before.agent), judgeBody(agents.after, after.agent))
      : false;
  if (judgeChanged)
    out.push(
      loosens(
        `${at}.agent`,
        `${after.name} is judged by ${after.agent ?? "its built-in agent"}, told something else than before.`,
      ),
    );
  else if (before.agent !== after.agent && !(type.judges === "agent" && agents))
    out.push(
      type.judges
        ? // Who judges the work is policy (Q16): a different judge may pass what the old one sent back.
          loosens(
            `${at}.agent`,
            `${after.name} is judged by ${after.agent ?? "its built-in agent"}.`,
          )
        : {
            path: `${at}.agent`,
            class: "neutral",
            summary: `${after.name} hands to ${after.agent ?? "its built-in agent"}.`,
          },
    );
  if (before.name !== after.name)
    out.push({
      path: `${at}.name`,
      class: "neutral",
      summary: `${before.name} is now ${after.name}.`,
    });
  return out;
}

/**
 * How `after` differs from `before`. Stages are matched by id. `before` is the version to compare
 * against: the saved one, the last one archived under this id, or the built-in floor for a new
 * workflow (`orgConfigImpact` chooses).
 */
export function workflowImpact(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
  agents?: ImpactAgents,
): PolicyImpact {
  const changes: ImpactChange[] = [];
  const was = new Map(before.stages.map((s) => [s.id, s]));
  const now = new Map(after.stages.map((s) => [s.id, s]));
  // Every removal loosens: a gate or a check is gone, or (triage, build) what a later gate or check
  // depends on is, for example items arriving unsized and so missing the spec gate.
  for (const s of before.stages) {
    if (now.has(s.id)) continue;
    changes.push(loosens(`stages.${s.id}`, `Removes ${s.name}.`));
  }
  for (const s of after.stages) {
    const old = was.get(s.id);
    if (old) {
      changes.push(...stageImpact(old, s, agents));
      continue;
    }
    // An added check or gate that runs for every item only adds to what is seen. Anything else
    // added (work that produces something, a conditional check) is not on the allow-list. An added
    // stage that acts outside the factory (a merge, a publish, a deploy, a PR it opens) is an action
    // gained, never a tightening, even though it has a gate: a workflow that never merged now does.
    // A check whose only outward act is producing an artifact an earlier stage already produces (a
    // second Checks stage: the PR exists) opens nothing; it checks the existing one, so it tightens.
    const type = stageType(s.type);
    const check =
      type !== undefined && guards(type, s.settings) && !s.when && parse(type, s.settings) !== null;
    if (type && actsOutside(type, s.settings) && !(check && checksExisting(type, s, after)))
      changes.push(
        loosens(
          `stages.${s.id}`,
          `Adds ${s.name}, which acts outside the factory (${type.reversibility}).`,
        ),
      );
    else if (check)
      changes.push({
        path: `stages.${s.id}`,
        class: "tightens",
        summary: `Adds ${s.name}, a gate or a check.`,
      });
    else
      changes.push(
        loosens(`stages.${s.id}`, `Adds ${s.name}, which isn't only a check or a gate.`),
      );
  }
  // Order: every pair of stages both versions have keeps its order. A check or gate moved before
  // something it used to follow (it no longer sees that work), or work moved after a gate that used
  // to follow it, loosens; any other reorder isn't on the allow-list either.
  const common = before.stages.map((s) => s.id).filter((id) => now.has(id));
  const posAfter = new Map(after.stages.map((s, i) => [s.id, i]));
  const moved = new Set<string>();
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      const first = common[i] as string;
      const second = common[j] as string;
      if ((posAfter.get(first) ?? 0) < (posAfter.get(second) ?? 0)) continue;
      const key = `${first}<${second}`;
      if (moved.has(key)) continue;
      moved.add(key);
      changes.push(
        loosens(
          `stages.${second}`,
          `${now.get(second)?.name ?? second} now runs before ${now.get(first)?.name ?? first}.`,
        ),
      );
    }
  }
  if (before.name !== after.name || before.description !== after.description)
    changes.push({
      path: "workflow.name",
      class: "neutral",
      summary: "Name or description changed.",
    });
  if (!same(before.template, after.template))
    changes.push({
      path: "workflow.template",
      class: "neutral",
      summary: "Template reference changed.",
    });
  if (before.schema !== after.schema || before.id !== after.id)
    changes.push(loosens("workflow", "The workflow's schema or id changed."));
  return summarise(changes);
}

export function summarise(changes: ImpactChange[]): PolicyImpact {
  const cls = changes.some((c) => c.class === "loosens")
    ? "loosens"
    : changes.some((c) => c.class === "tightens")
      ? "tightens"
      : "neutral";
  return { class: cls, changes };
}
