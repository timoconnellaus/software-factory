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

/** Control and format characters (not newline or tab): text a person can't see doesn't go in. */
function hasHidden(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) return true;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)) return true;
    if ((c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) return true;
  }
  return false;
}

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
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300),
    body: z
      .string()
      .min(1)
      .max(MAX_SKILL_BODY)
      .refine((b) => !hasHidden(b), "no control or invisible format characters"),
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
