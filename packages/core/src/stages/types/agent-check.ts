import { MODEL_ROLES } from "@software-factory/runner-contract";
import { z } from "zod";
import type { StageType } from "../contract.ts";
import { gateStep, jobStep, latest } from "../reconcile.ts";
import { instructionsSchema } from "../settings.ts";

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
  // Reads and reports pass, send back (to what it checks) or ask (a person decides, workflow.gate).
  next: (ctx) => {
    const at = ctx.entry.stageId;
    const work = jobStep(ctx, "check", 0);
    if (work) return work;
    const verdict = latest(ctx.steps, "check")?.step.output?.verdict ?? "pass";
    if (verdict === "sendBack")
      return {
        kind: "sendBack",
        stageId: at,
        to: "",
        note: latest(ctx.steps, "check")?.step.output?.note ?? "",
      };
    if (verdict === "ask")
      return (
        gateStep(ctx, "ask", { kind: "step", operation: "workflow.gate" }, "check", (note) => ({
          kind: "sendBack",
          stageId: at,
          to: "",
          note,
        })) ?? { kind: "complete", stageId: at }
      );
    return { kind: "complete", stageId: at };
  },
  impact: (before, after, stageId) =>
    before.instructions === after.instructions
      ? []
      : [{ path: `${stageId}.instructions`, class: "neutral", summary: "Instructions changed." }],
};
