import { z } from "zod";
import type { ImpactChange } from "../../policy/impact.ts";
import { SIZE_RANK, SIZES, type StageType } from "../contract.ts";
import { deciderImpact, deciderSchema } from "../settings.ts";

const settings = z
  .object({
    /** The smallest size that gets the spec gate (ADR 0013); `large` always does. */
    requiredFrom: z.enum(SIZES).default("medium"),
    decider: deciderSchema.default("approvers"),
    /** The spec critic (ADR 0302): advisory, it can't open or skip the gate. */
    critic: z.boolean().default(false),
    /** Planning may split a large item into several (spec 20). */
    split: z.boolean().default(true),
  })
  .strict();

/** The live planning session (spec 20) and the spec gate, conditional on size. */
export const interviewPlanning: StageType<typeof settings> = {
  id: "interview-planning",
  version: 1,
  name: "Interview planning",
  description:
    "A live planning session with questions, chat and mockups, ending in a spec a person approves.",
  phases: ["shaping", "delivery"],
  settings,
  consumes: ["brief"],
  produces: ["plan", "spec"],
  evidence: [],
  surface: "interview",
  requires: () => ({
    capabilities: [],
    connectors: [],
    // Today the plan lives in the repo's `.kim/` (ADR 0305). With no repository it moves to R2
    // (spec 52, Q15), which the build adds with the first project that has none.
    repository: true,
    pool: "light",
    roles: ["triage"],
  }),
  gate: (s) => ({
    kind: "spec",
    decider: s.decider,
    mode: "conditional",
    on: "spec",
    outcomes: ["approve", "requestChanges", "reject"],
    operation: "spec.approve",
    risk: "write",
    delegable: ["adjudicator"],
  }),
  needsPerson: true,
  reversibility: "internal",
  steps: () => [
    { id: "session", kind: "agent", role: "triage" },
    { id: "spec-gate", kind: "decision" },
  ],
  impact: (before, after, stageId) => {
    const out: ImpactChange[] = [];
    const was = SIZE_RANK[before.requiredFrom];
    const now = SIZE_RANK[after.requiredFrom];
    if (was !== now)
      out.push({
        path: `${stageId}.requiredFrom`,
        class: now > was ? "loosens" : "tightens",
        summary: `Spec required from ${before.requiredFrom} → ${after.requiredFrom}.`,
      });
    out.push(...deciderImpact(`${stageId}.decider`, before.decider, after.decider));
    if (before.critic !== after.critic)
      out.push({
        path: `${stageId}.critic`,
        class: after.critic ? "tightens" : "loosens",
        summary: `The spec critic ${after.critic ? "on" : "off"}.`,
      });
    if (before.split !== after.split)
      out.push({
        path: `${stageId}.split`,
        class: "neutral",
        summary: `Splitting large items ${after.split ? "on" : "off"}.`,
      });
    return out;
  },
};
