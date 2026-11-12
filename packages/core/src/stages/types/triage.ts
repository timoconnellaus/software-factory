import { z } from "zod";
import type { ImpactChange } from "../../policy/impact.ts";
import type { StageType } from "../contract.ts";
import { jobStep } from "../reconcile.ts";

const settings = z
  .object({
    /** Triage may ask the requester a question before it sizes the item (ADR 0304). */
    mayAsk: z.boolean().default(true),
    /** Triage scores readiness (ADR 0304). */
    readiness: z.boolean().default(true),
  })
  .strict();

/** Sizes the item, names its domains, scores readiness and writes criteria. The one shaping stage
 * that needs no person (spec 52, Q1). */
export const triage: StageType<typeof settings> = {
  id: "triage",
  version: 1,
  name: "Triage",
  description:
    "Sizes the item, names the domains it touches, scores readiness and drafts criteria.",
  phases: ["shaping", "delivery"],
  settings,
  consumes: ["brief"],
  produces: ["brief"],
  evidence: [],
  surface: "run",
  requires: () => ({
    capabilities: [],
    connectors: [],
    repository: false,
    pool: "light",
    roles: ["triage"],
  }),
  gate: () => null,
  needsPerson: false,
  shapingWithoutPerson: true,
  reversibility: "internal",
  steps: () => [{ id: "triage", kind: "agent", role: "triage" }],
  // Sizes the item; retried like a build (the Workflow's runWithRetries).
  next: (ctx) =>
    jobStep(ctx, "triage", ctx.item.retryLimit) ?? { kind: "complete", stageId: ctx.entry.stageId },
  impact: (before, after, stageId) => {
    const out: ImpactChange[] = [];
    for (const key of ["mayAsk", "readiness"] as const) {
      if (before[key] !== after[key])
        out.push({
          path: `${stageId}.${key}`,
          class: "neutral",
          summary: `Triage ${key === "mayAsk" ? "asking questions" : "scoring readiness"} ${after[key] ? "on" : "off"}.`,
        });
    }
    return out;
  },
};
