import { z } from "zod";
import type { ImpactChange } from "../../policy/impact.ts";
import { same } from "../../policy/impact.ts";
import { DEFAULT_REQUIRED_CHECKS } from "../../verify/protection.ts";
import type { EvidenceKind, StageType } from "../contract.ts";
import { jobStep, latest } from "../reconcile.ts";

const EVIDENCE = ["ci", "check", "criteria", "reviewer", "drift", "tests-intact"] as const;

const settings = z
  .object({
    /** Today's CI waits (Workflow v3): minutes per wait, rounds, and rounds with no CI at all. */
    ci: z
      .object({
        waitMinutes: z.number().int().min(1).max(60).default(10),
        rounds: z.number().int().min(1).max(48).default(12),
        missingRounds: z.number().int().min(1).max(12).default(3),
      })
      .strict()
      .default({ waitMinutes: 10, rounds: 12, missingRounds: 3 }),
    /** The independent reviewer agent. Its prompt is code's and takes no project text (F10). */
    reviewer: z.boolean().default(true),
    /** The build against the approved spec (ADR 0306). */
    drift: z.boolean().default(true),
    /** Evidence the verdict requires. */
    requiredEvidence: z
      .array(z.enum(EVIDENCE))
      .max(EVIDENCE.length)
      .default(["ci", "criteria", "reviewer"]),
    /** CI checks that must report on the SHA besides `factory/verify` (ADR 0280). */
    requiredChecks: z
      .array(z.string().min(1).max(200))
      .max(20)
      .default([...DEFAULT_REQUIRED_CHECKS]),
    /** The review packet's sections in order (spec 14). Absent: the default order. */
    sections: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/** Open the PR, run the checks on the exact commit, read CI, the reviewer, and assemble the packet. */
export const checks: StageType<typeof settings> = {
  id: "checks",
  version: 1,
  name: "Checks",
  description:
    "Opens the pull request, checks the exact commit, reads CI and an independent reviewer, and writes the review packet.",
  phases: ["delivery"],
  settings,
  consumes: ["git-head"],
  produces: ["pull-request"],
  evidence: [
    { kind: "ci", required: true, about: "pull-request" },
    { kind: "check", required: false, about: "pull-request" },
    { kind: "criteria", required: true, about: "pull-request" },
    { kind: "reviewer", required: true, about: "pull-request" },
    { kind: "drift", required: false, about: "pull-request" },
    { kind: "tests-intact", required: false, about: "pull-request" },
  ],
  surface: "checks",
  requires: () => ({
    capabilities: [],
    connectors: ["github"],
    repository: true,
    pool: "heavy",
    roles: ["review"],
  }),
  gate: () => null,
  needsPerson: false,
  reversibility: "reversible-outside",
  // Its reviewer is code's (F10): no org agent, no org text but additions a person approves (Q16).
  judges: "code",
  steps: (s) => [
    { id: "open-pr", kind: "check" },
    { id: "ci", kind: "check" },
    ...(s.reviewer ? [{ id: "reviewer", kind: "agent" as const, role: "review" as const }] : []),
  ],
  // The verify run, then CI on the head. A failure goes back to what made the head, until the
  // retry limit; a missing or pending CI waits (the tick re-reads it, which heals a lost event).
  next: (ctx) => {
    const at = ctx.entry.stageId;
    const work = jobStep(ctx, "verify", ctx.item.retryLimit);
    if (work) return work;
    const failures = latest(ctx.steps, "verify")?.step.output?.failures ?? [];
    const ci = ctx.observations.ci ?? "missing";
    if (failures.length === 0 && ci === "pass") return { kind: "complete", stageId: at };
    if (failures.length === 0 && (ci === "pending" || ci === "missing"))
      return { kind: "wait", stageId: at, why: "ci" };
    // The send-back is a failed attempt: the reconciler fails the item once the item's failures
    // pass its retry limit (counted across the item, as today).
    return {
      kind: "sendBack",
      stageId: at,
      to: "",
      note: failures.length ? `failing: ${failures.join(", ")}` : "CI failed on the head",
    };
  },
  impact: (before, after, stageId) => {
    const out: ImpactChange[] = [];
    for (const key of ["reviewer", "drift"] as const) {
      if (before[key] !== after[key])
        out.push({
          path: `${stageId}.${key}`,
          class: after[key] ? "tightens" : "loosens",
          summary: `The ${key === "reviewer" ? "reviewer" : "drift check"} ${after[key] ? "on" : "off"}.`,
        });
    }
    out.push(
      ...setImpact(
        `${stageId}.requiredEvidence`,
        before.requiredEvidence,
        after.requiredEvidence,
        "evidence",
      ),
      ...setImpact(
        `${stageId}.requiredChecks`,
        before.requiredChecks,
        after.requiredChecks,
        "check",
      ),
    );
    if (!same(before.ci, after.ci))
      out.push({ path: `${stageId}.ci`, class: "neutral", summary: "CI waits changed." });
    if (!same(before.sections, after.sections)) out.push(sectionsImpact(stageId, before, after));
    return out;
  },
};

/**
 * The review packet's sections. Absent means every section, so setting a list where there was none
 * may hide any section: a loosening. Dropping one loosens, only adding tightens, reordering is
 * neutral, and going back to "every section" tightens.
 */
function sectionsImpact(
  stageId: string,
  before: { sections?: string[] | undefined },
  after: { sections?: string[] | undefined },
): ImpactChange {
  const path = `${stageId}.sections`;
  if (!after.sections)
    return { path, class: "tightens", summary: "The review packet shows every section again." };
  if (!before.sections)
    return {
      path,
      class: "loosens",
      summary: `The review packet shows only ${after.sections.join(", ")}, hiding every other section.`,
    };
  const was = before.sections;
  const now = after.sections;
  const hidden = was.filter((x) => !now.includes(x));
  if (hidden.length > 0)
    return {
      path,
      class: "loosens",
      summary: `Hides ${hidden.join(", ")} from the review packet.`,
    };
  const added = now.filter((x) => !was.includes(x));
  return added.length > 0
    ? { path, class: "tightens", summary: `Adds ${added.join(", ")} to the review packet.` }
    : { path, class: "neutral", summary: "Review packet sections reordered." };
}

function setImpact(
  path: string,
  before: readonly (string | EvidenceKind)[],
  after: readonly (string | EvidenceKind)[],
  noun: string,
): ImpactChange[] {
  const dropped = before.filter((x) => !after.includes(x));
  const added = after.filter((x) => !before.includes(x));
  const out: ImpactChange[] = [];
  if (dropped.length)
    out.push({
      path,
      class: "loosens",
      summary: `No longer requires the ${noun} ${dropped.join(", ")}.`,
    });
  if (added.length)
    out.push({
      path,
      class: "tightens",
      summary: `Also requires the ${noun} ${added.join(", ")}.`,
    });
  if (!out.length && !same(before, after))
    out.push({ path, class: "neutral", summary: `The required ${noun}s reordered.` });
  return out;
}
