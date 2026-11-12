import { z } from "zod";
import type { ImpactChange } from "../../policy/impact.ts";
import type { StageType } from "../contract.ts";
import { jobStep } from "../reconcile.ts";

const settings = z
  .object({
    /** Automatic retries of a failed build or verify before the item fails (ADR 0005). */
    retryLimit: z.number().int().min(0).max(5).default(2),
    /** Free rounds to merge the default branch into a conflicting PR (ADR 0320). */
    conflictRounds: z.number().int().min(1).max(5).default(3),
  })
  .strict();

/** An agent builds in the repository, merging the default branch first (ADR 0320). */
export const build: StageType<typeof settings> = {
  id: "build",
  version: 1,
  name: "Build",
  description: "An agent builds the change on the item's branch, after merging the default branch.",
  phases: ["delivery"],
  settings,
  overridable: ["retryLimit"],
  consumes: ["brief"],
  produces: ["git-head"],
  evidence: [],
  surface: "run",
  requires: () => ({
    capabilities: [],
    connectors: ["github"],
    repository: true,
    pool: "heavy",
    roles: ["implement"],
  }),
  gate: () => null,
  needsPerson: false,
  reversibility: "internal",
  steps: () => [{ id: "build", kind: "agent", role: "implement" }],
  // Both are bounded in the schema; ADR 0373 counts the retry limit as practice.
  next: (ctx) =>
    jobStep(ctx, "build", ctx.item.retryLimit) ?? { kind: "complete", stageId: ctx.entry.stageId },
  impact: (before, after, stageId) => {
    const out: ImpactChange[] = [];
    if (before.retryLimit !== after.retryLimit)
      out.push({
        path: `${stageId}.retryLimit`,
        class: "neutral",
        summary: `Retry limit ${before.retryLimit} → ${after.retryLimit}.`,
      });
    if (before.conflictRounds !== after.conflictRounds)
      out.push({
        path: `${stageId}.conflictRounds`,
        class: "neutral",
        summary: `Conflict rounds ${before.conflictRounds} → ${after.conflictRounds}.`,
      });
    return out;
  },
};
