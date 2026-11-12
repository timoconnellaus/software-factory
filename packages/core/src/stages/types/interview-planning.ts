import { z } from "zod";
import type { ImpactChange } from "../../policy/impact.ts";
import { SIZE_RANK, SIZES, type StageType } from "../contract.ts";
import { gateStep, jobStep } from "../reconcile.ts";
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
    // The operation the Workflow opens the spec gate with, and its registry risk (`plan`, which the
    // gate sends to review for agents under every autonomy policy).
    operation: "spec.accept",
    risk: "plan",
    delegable: ["adjudicator"],
  }),
  needsPerson: true,
  reversibility: "internal",
  steps: () => [
    { id: "session", kind: "agent", role: "triage" },
    { id: "spec-gate", kind: "decision" },
  ],
  // Skipped below the size threshold unless the foreman asked for a spec; `large` always runs it.
  // An unsized item (no triage before it) runs it: fail-safe.
  skip: (s, item) => {
    if (!item.size) return null;
    if (item.size === "large" || SIZE_RANK[item.size] >= SIZE_RANK[s.requiredFrom]) return null;
    if (item.specRequested === "require") return null;
    return `sized ${item.size}, below the spec threshold (${s.requiredFrom})`;
  },
  // The planning session, then the spec gate; changes requested runs the session again.
  next: (ctx) => {
    const at = ctx.entry.stageId;
    const work = jobStep(ctx, "session", ctx.item.retryLimit);
    if (work) return work;
    return (
      gateStep(ctx, "spec-gate", { kind: "spec", operation: "spec.accept" }, "session", () => ({
        kind: "job",
        stageId: at,
        stepId: "session",
        attempt: ctx.steps.filter((x) => x.stepId === "session").length + 1,
      })) ?? { kind: "complete", stageId: at }
    );
  },
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
