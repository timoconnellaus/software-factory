import { MODEL_ROLES } from "@software-factory/runner-contract";
import { z } from "zod";
import type { StageType } from "../contract.ts";
import { instructionsImpact, instructionsSchema } from "../settings.ts";

const settings = z.object({ instructions: instructionsSchema }).strict();

/**
 * An advisory agent step (today's slot `work` step, ADR 0371): it reads and reports pass, send back
 * or ask. It never builds, so its agent may not have role `implement` (checked by the validator).
 */
export const agentCheck: StageType<typeof settings> = {
  id: "agent-check",
  version: 1,
  name: "Agent check",
  description:
    "An agent reads the work and passes it, sends it back with a note, or asks a person.",
  phases: ["delivery"],
  settings,
  consumes: [],
  produces: [],
  evidence: [{ kind: "reviewer", required: false, about: "git-head" }],
  surface: "run",
  small: true,
  requires: () => ({
    capabilities: [],
    connectors: [],
    repository: true,
    // Read-only `verify`-stage jobs (spec 09 M2 as built), on the verify stage's pool.
    pool: "heavy",
    roles: MODEL_ROLES.filter((r) => r !== "implement"),
  }),
  gate: () => null,
  needsPerson: false,
  reversibility: "internal",
  // Its named agent judges the work: changing the agent, or the agent's instructions, loosens.
  judges: "agent",
  steps: () => [{ id: "check", kind: "agent" }],
  impact: (before, after, stageId) =>
    instructionsImpact(`${stageId}.instructions`, before.instructions, after.instructions),
};
