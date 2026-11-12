// Settings pieces shared by several stage types.
import { z } from "zod";
import type { ImpactChange } from "../policy/impact.ts";
import { type Decider, deciderChange, SIZE_RANK, SIZES, type Size } from "./contract.ts";

export const deciderSchema: z.ZodType<Decider> = z.union([
  z.literal("approvers"),
  z.object({ person: z.string().trim().min(1).max(100) }).strict(),
]);

/** A typed condition: run only for items at least this size, or touching this domain. */
export const conditionSchema = z
  .object({
    sizeAtLeast: z.enum(SIZES).optional(),
    domain: z.string().min(1).max(40).optional(),
  })
  .strict();
export type Condition = z.infer<typeof conditionSchema>;

/** Standing text appended to an agent's or a person's prompt. Never a code-owned prompt (F10). */
export const instructionsSchema = z.string().max(4_000).default("");

/**
 * What a judging stage is told (an agent check's or a decision's instructions). Free text can't be
 * shown to only add requirements: an appended "pass everything" overrides what came before. So any
 * change loosens, a person decides it.
 */
export function instructionsImpact(path: string, before: string, after: string): ImpactChange[] {
  if (before === after) return [];
  return [
    {
      path,
      class: "loosens",
      summary: after
        ? "Changes what the judge is told: it may now pass what it sent back."
        : "Removes what the judge was told.",
    },
  ];
}

export function deciderImpact(path: string, before: Decider, after: Decider): ImpactChange[] {
  const change = deciderChange(before, after);
  if (change === "same") return [];
  const who = (d: Decider) => (d === "approvers" ? "the approvers" : d.person);
  return [
    {
      path,
      class: change,
      summary: `${who(before)} → ${who(after)} decide${after === "approvers" ? "" : "s"}.`,
    },
  ];
}

/**
 * A condition on a check or a gate: one that runs it for fewer items loosens, for more tightens.
 * `undefined` means "always".
 */
export function conditionImpact(
  path: string,
  before: Condition | undefined,
  after: Condition | undefined,
): ImpactChange[] {
  const b = before ?? {};
  const a = after ?? {};
  const out: ImpactChange[] = [];
  const rank = (s: Size | undefined) => (s ? SIZE_RANK[s] : -1);
  if (rank(a.sizeAtLeast) > rank(b.sizeAtLeast))
    out.push({ path, class: "loosens", summary: `Runs only from ${a.sizeAtLeast} work.` });
  else if (rank(a.sizeAtLeast) < rank(b.sizeAtLeast))
    out.push({ path, class: "tightens", summary: "Runs for smaller work too." });
  if (a.domain !== b.domain) {
    out.push({
      path,
      class: a.domain ? "loosens" : "tightens",
      summary: a.domain
        ? `Runs only when the work touches ${a.domain}.`
        : "Runs whatever the domain.",
    });
  }
  return out;
}

/** True when `size` meets the condition (an unsized item meets no size condition). */
export function conditionHolds(
  when: Condition | undefined,
  size: Size | null,
  domains: readonly string[],
): { holds: true } | { holds: false; why: string } {
  if (when?.sizeAtLeast && (size ? SIZE_RANK[size] : -1) < SIZE_RANK[when.sizeAtLeast])
    return {
      holds: false,
      why: `only for ${when.sizeAtLeast} work and up (this is ${size ?? "unsized"})`,
    };
  if (when?.domain && !domains.includes(when.domain))
    return { holds: false, why: `only when the work touches ${when.domain}` };
  return { holds: true };
}
