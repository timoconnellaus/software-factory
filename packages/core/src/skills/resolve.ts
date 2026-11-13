// Which skills a job follows (spec 52, "How a run's skills are resolved"). Pure; runs when a job is
// built. In order, deduplicated by id: the stage type's built-in skills (each extended or replaced by
// an org skill that overrides it), the agent's skills, then the stage's attached skills whose
// condition holds. A path condition with no paths known yet includes the skill: loading one too many
// is cheaper than missing one.
import { globMatch } from "../policy/glob.ts";
import { SIZE_RANK, type Size } from "../stages/contract.ts";
import { BUILTIN_SKILLS } from "./builtin.ts";
import { type SkillCondition, skillSlug } from "./schema.ts";

/** An org skill at the version the org config names. */
export interface OrgSkill {
  id: string;
  version: number;
  name: string;
  description: string;
  sha256: string;
  overrides: { builtin: string; mode: "extend" | "replace" } | null;
}

export interface ResolvedSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** 0 for a built-in (versioned with its stage type). */
  version: number;
  sha256: string | null;
  from: "builtin" | "agent" | "stage";
}

export interface SkillFacts {
  size: Size | null;
  domains: readonly string[];
  /** The paths the change is known to touch; null when nothing is known yet. */
  paths: readonly string[] | null;
}

/** Whether a stage attachment's condition holds for the item. */
export function skillConditionHolds(when: SkillCondition | undefined, facts: SkillFacts): boolean {
  if (!when) return true;
  if (when.sizeAtLeast && (!facts.size || SIZE_RANK[facts.size] < SIZE_RANK[when.sizeAtLeast]))
    return false;
  if (when.domain && !facts.domains.includes(when.domain)) return false;
  if (when.paths && facts.paths !== null)
    return facts.paths.some((p) => when.paths?.some((g) => globMatch(g, p)));
  return true;
}

export function resolveSkills(input: {
  stageType: string;
  /** The org's skills at their current versions in the pinned org config. */
  orgSkills: ReadonlyMap<string, OrgSkill>;
  agentSkills: readonly string[];
  stageSkills: readonly { skill: string; when?: SkillCondition | undefined }[];
  facts: SkillFacts;
}): ResolvedSkill[] {
  const out: ResolvedSkill[] = [];
  const seen = new Set<string>();
  const org = (s: OrgSkill, from: ResolvedSkill["from"]): ResolvedSkill => ({
    id: s.id,
    slug: skillSlug(s.name),
    name: s.name,
    description: s.description,
    version: s.version,
    sha256: s.sha256,
    from,
  });
  const add = (r: ResolvedSkill) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  const builtinRef = (id: string): ResolvedSkill | null => {
    const s = BUILTIN_SKILLS.find((x) => x.id === id);
    return s
      ? {
          id: s.id,
          slug: s.slug,
          name: s.name,
          description: s.description,
          version: 0,
          sha256: null,
          from: "builtin",
        }
      : null;
  };
  // 1. The type's built-ins, extended or replaced by the org's overrides (built-in text first).
  // Only the org skills that override one of this type's built-ins (review of #155).
  const own = new Set(BUILTIN_SKILLS.filter((x) => x.type === input.stageType).map((x) => x.id));
  const overriding = [...input.orgSkills.values()].filter(
    (s) => s.overrides && own.has(s.overrides.builtin),
  );
  for (const s of BUILTIN_SKILLS.filter((x) => x.type === input.stageType)) {
    const over = overriding.filter((o) => o.overrides?.builtin === s.id);
    const replaced = over.find((o) => o.overrides?.mode === "replace");
    if (replaced) add(org(replaced, "builtin"));
    else {
      const ref = builtinRef(s.id);
      if (ref) add(ref);
      for (const o of over) add(org(o, "builtin"));
    }
  }
  // 2. The agent's, always. 3. The stage's, where the condition holds.
  const named = (id: string, from: ResolvedSkill["from"]) => {
    const s = input.orgSkills.get(id);
    if (s) add(org(s, from));
    else {
      const ref = builtinRef(id);
      if (ref) add({ ...ref, from });
    }
  };
  for (const id of input.agentSkills) named(id, "agent");
  for (const a of input.stageSkills)
    if (skillConditionHolds(a.when, input.facts)) named(a.skill, "stage");
  return out;
}
