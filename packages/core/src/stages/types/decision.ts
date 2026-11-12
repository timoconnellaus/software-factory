import { z } from "zod";
import type { ImpactChange } from "../../policy/impact.ts";
import type { StageType } from "../contract.ts";
import {
  conditionImpact,
  conditionSchema,
  deciderImpact,
  deciderSchema,
  instructionsSchema,
} from "../settings.ts";

const settings = z
  .object({
    decider: deciderSchema.default("approvers"),
    instructions: instructionsSchema,
    /** A typed condition: the gate runs only for items it holds for. Absent: always. */
    when: conditionSchema.optional(),
  })
  .strict();

/** A person's decision as its own stage (today's slot `gate` step, `workflow.gate`). */
export const decision: StageType<typeof settings> = {
  id: "decision",
  version: 1,
  name: "Decision",
  description: "A person looks at the work and approves it or sends it back.",
  phases: ["shaping", "delivery"],
  settings,
  consumes: [],
  produces: [],
  evidence: [],
  surface: "packet",
  small: true,
  requires: () => ({
    capabilities: [],
    connectors: [],
    repository: false,
    pool: "none",
    roles: [],
  }),
  gate: (s) => ({
    kind: "step",
    decider: s.decider,
    mode: s.when ? "conditional" : "required",
    on: "brief",
    outcomes: ["approve", "sendBack", "reject"],
    operation: "workflow.gate",
    risk: "plan",
    delegable: ["adjudicator"],
  }),
  needsPerson: true,
  reversibility: "internal",
  steps: () => [{ id: "decide", kind: "decision" }],
  impact: (before, after, stageId) => {
    const out: ImpactChange[] = [
      ...deciderImpact(`${stageId}.decider`, before.decider, after.decider),
      ...conditionImpact(`${stageId}.when`, before.when, after.when),
    ];
    if (before.instructions !== after.instructions)
      out.push({
        path: `${stageId}.instructions`,
        class: "neutral",
        summary: "Instructions changed.",
      });
    return out;
  },
};
