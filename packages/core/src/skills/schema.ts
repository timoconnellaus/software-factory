// Skills (spec 52, ADR 0513): how the team does one thing, written once, owned by the org and shared
// by every agent. A skill attaches to an org agent (always), to a stage in a workflow (optionally
// with a condition), and stage types ship their own built-in skills.
import { z } from "zod";

/** An org skill's id: stable across versions. */
export const skillIdSchema = z
  .string()
  .regex(/^sk_[a-z0-9_]{1,60}$/, "a skill id: sk_ then a-z, 0-9, _");
/** A built-in skill's id: `builtin:<stage type>:<slug>`. */
export const builtinSkillIdSchema = z.string().regex(/^builtin:[a-z-]+:[a-z0-9-]+$/);
/** Either, as attachments name them. */
export const anySkillIdSchema = z.union([skillIdSchema, builtinSkillIdSchema]);

export const MAX_SKILL_BODY = 16_000;
export const MAX_SKILL_VERSIONS = 500;
/** Skills an org may have (review of #155): a clear refusal past it. */
export const MAX_ORG_SKILLS = 200;
/** Open proposals an org may have waiting, and one proposer's a day. */
export const MAX_OPEN_PROPOSALS = 50;
export const MAX_PROPOSALS_A_DAY = 10;

/**
 * Text a person can't see doesn't go in (reviews of #155): every format, control, line and
 * paragraph separator character, by Unicode category rather than a list of ranges, and the
 * fillers and joiners that render as nothing. A body may keep newlines and tabs; a name or a
 * description may not.
 */
const INVISIBLE =
  /\p{Cf}|\p{Cc}|\p{Zl}|\p{Zp}|\u034F|\u115F|\u1160|\u180B|\u180C|\u180D|\u180E|\u180F|\u2800|\u3164|\uFFA0|\p{Variation_Selector}/u;
export function hasHidden(text: string, allowLines = false): boolean {
  return INVISIBLE.test(allowLines ? text.replace(/[\n\t]/g, "") : text);
}
const visible = (what: string, allowLines = false) =>
  [
    (t: string) => !hasHidden(t, allowLines),
    `no control or invisible characters in the ${what}`,
  ] as const;

/** When a stage's attached skill applies to an item (spec 52, Skills). Absent: always. */
export const skillConditionSchema = z
  .object({
    /** Globs over the paths the change touches (`packages/db/**`). */
    paths: z.array(z.string().min(1).max(200)).max(20).optional(),
    sizeAtLeast: z.enum(["small", "medium", "large"]).optional(),
    domain: z.string().min(1).max(40).optional(),
  })
  .strict();
export type SkillCondition = z.infer<typeof skillConditionSchema>;

/** A stage's attachment. */
export const stageSkillSchema = z
  .object({ skill: anySkillIdSchema, when: skillConditionSchema.optional() })
  .strict();

/** What a person (or the factory, proposing) writes as one version of a skill. */
export const skillDraftSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(...visible("name")),
    description: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine(...visible("description")),
    body: z
      .string()
      .min(1)
      .max(MAX_SKILL_BODY)
      .refine(...visible("instructions", true)),
    /** It changes a stage type's built-in skill: appended to it, or in its place. */
    overrides: z
      .object({ builtin: builtinSkillIdSchema, mode: z.enum(["extend", "replace"]) })
      .strict()
      .optional(),
    provenance: z
      .object({
        incidentId: z.string().max(60).optional(),
        workItemId: z.string().max(60).optional(),
        note: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SkillDraft = z.infer<typeof skillDraftSchema>;

/** The harness-side name: the skill's name as a slug. */
export function skillSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  );
}
