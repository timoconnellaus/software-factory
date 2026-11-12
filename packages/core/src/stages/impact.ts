// `workflowImpact`: a workflow change classified as loosens, tightens or neutral (spec 52, "The
// impact check"), extending ADR 0370's `policyImpact`. Anything it can't classify loosens.
import { type ImpactChange, type PolicyImpact, same } from "../policy/impact.ts";
import type { AnyStageType } from "./contract.ts";
import { stageType } from "./registry.ts";
import { conditionImpact } from "./settings.ts";
import type { StageInstance, WorkflowDefinition } from "./workflow.ts";

/** A stage whose removal, skipping or moving later weakens what a person or a check sees. */
function guards(type: AnyStageType | undefined, settings: unknown): boolean {
  if (!type) return true;
  if (type.id === "checks" || type.id === "agent-check") return true;
  return type.gate(parse(type, settings)) !== null;
}

function parse(type: AnyStageType, settings: unknown): unknown {
  const parsed = type.settings.safeParse(settings ?? {});
  return parsed.success ? parsed.data : type.settings.parse({});
}

function stageImpact(before: StageInstance, after: StageInstance): ImpactChange[] {
  const at = after.id;
  if (before.type !== after.type || before.typeVersion !== after.typeVersion) {
    return [
      {
        path: `stages.${at}`,
        class: before.type !== after.type ? "loosens" : "neutral",
        summary:
          before.type !== after.type
            ? `${after.name} changes from ${before.type} to ${after.type}.`
            : `${after.name} moves to version ${after.typeVersion} of its type.`,
      },
    ];
  }
  const type = stageType(after.type);
  const out: ImpactChange[] = [];
  if (!type) {
    if (!same(before, after))
      out.push({ path: `stages.${at}`, class: "loosens", summary: `${after.name} changed.` });
    return out;
  }
  out.push(
    ...type.impact(parse(type, before.settings), parse(type, after.settings), `stages.${at}`),
  );
  if (!same(before.when, after.when)) {
    if (guards(type, after.settings))
      out.push(...conditionImpact(`stages.${at}.when`, before.when, after.when));
    else
      out.push({
        path: `stages.${at}.when`,
        class: "neutral",
        summary: `${after.name} runs for different items.`,
      });
  }
  if (before.phase !== after.phase)
    out.push({
      path: `stages.${at}.phase`,
      class: "loosens",
      summary: `${after.name} moves from ${before.phase} to ${after.phase}.`,
    });
  if (before.agent !== after.agent)
    out.push({
      path: `stages.${at}.agent`,
      class: "neutral",
      summary: `${after.name} hands to ${after.agent ?? "its built-in agent"}.`,
    });
  if (before.name !== after.name)
    out.push({
      path: `stages.${at}.name`,
      class: "neutral",
      summary: `${before.name} is now ${after.name}.`,
    });
  return out;
}

/**
 * How `after` differs from `before` (null: a new workflow, which is neutral until a project uses
 * it). Stages are matched by id.
 */
export function workflowImpact(
  before: WorkflowDefinition | null,
  after: WorkflowDefinition | null,
): PolicyImpact {
  const changes: ImpactChange[] = [];
  if (!before || !after) {
    if (before || after)
      changes.push({
        path: "workflow",
        class: "neutral",
        summary: after
          ? `Adds the workflow ${after.name}.`
          : `Archives the workflow ${before?.name}.`,
      });
    return summarise(changes);
  }
  const was = new Map(before.stages.map((s) => [s.id, s]));
  const now = new Map(after.stages.map((s) => [s.id, s]));
  for (const s of before.stages) {
    if (now.has(s.id)) continue;
    const g = guards(stageType(s.type), s.settings);
    changes.push({
      path: `stages.${s.id}`,
      class: g ? "loosens" : "neutral",
      summary: `Removes ${s.name}${g ? ", a gate or a check" : ""}.`,
    });
  }
  for (const s of after.stages) {
    const old = was.get(s.id);
    if (!old) {
      const g = guards(stageType(s.type), s.settings);
      changes.push({
        path: `stages.${s.id}`,
        class: g ? "tightens" : "neutral",
        summary: `Adds ${s.name}${g ? ", a gate or a check" : ""}.`,
      });
      continue;
    }
    changes.push(...stageImpact(old, s));
  }
  // Order: a gate or check that now comes after a stage it used to precede sees less.
  const common = before.stages.map((s) => s.id).filter((id) => now.has(id));
  const posAfter = new Map(after.stages.map((s, i) => [s.id, i]));
  const moved = new Set<string>();
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      const a = common[i] as string;
      const b = common[j] as string;
      if ((posAfter.get(a) ?? 0) < (posAfter.get(b) ?? 0)) continue;
      const stage = now.get(a);
      if (stage && guards(stageType(stage.type), stage.settings) && !moved.has(a)) {
        moved.add(a);
        changes.push({
          path: `stages.${a}`,
          class: "loosens",
          summary: `${stage.name} now runs after ${now.get(b)?.name ?? b}.`,
        });
      }
    }
  }
  if (before.name !== after.name || before.description !== after.description)
    changes.push({
      path: "workflow.name",
      class: "neutral",
      summary: "Name or description changed.",
    });
  return summarise(changes);
}

function summarise(changes: ImpactChange[]): PolicyImpact {
  const cls = changes.some((c) => c.class === "loosens")
    ? "loosens"
    : changes.some((c) => c.class === "tightens")
      ? "tightens"
      : "neutral";
  return { class: cls, changes };
}
