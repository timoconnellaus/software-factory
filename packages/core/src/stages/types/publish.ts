import { z } from "zod";
import type { ImpactChange } from "../../policy/impact.ts";
import { same } from "../../policy/impact.ts";
import type { StageType } from "../contract.ts";
import { gateStep, latest } from "../reconcile.ts";
import { deciderImpact, deciderSchema } from "../settings.ts";

const settings = z
  .object({
    connector: z.literal("github").default("github"),
    /**
     * The outside action. Only `merge` exists today; `deploy` comes with a deploy stage and a
     * health check, `post` with the first social connector (spec 52, later PRs).
     */
    action: z.literal("merge").default("merge"),
    /** `mergeQueue`: the project's merge queue (ADR 0330); `direct`: an attached PR's merge. */
    via: z.enum(["mergeQueue", "direct"]).default("mergeQueue"),
    queue: z
      .object({
        waitHours: z.number().positive().max(48).default(1),
        updateReads: z.number().int().min(1).max(20).default(8),
      })
      .strict()
      .default({ waitHours: 1, updateReads: 8 }),
    decider: deciderSchema.default("approvers"),
  })
  .strict();

/**
 * A person's decision on the exact artifact, then the irreversible action through a connector. For
 * software: the merge gate (`pr.merge`, `ALWAYS_REVIEW`) and the merge queue.
 */
export const publish: StageType<typeof settings> = {
  id: "publish",
  version: 1,
  name: "Publish",
  description:
    "A person approves the exact artifact, then the factory takes the outside action: merge, deploy or post.",
  phases: ["delivery"],
  settings,
  consumes: ["pull-request"],
  produces: ["external-ref"],
  evidence: [],
  surface: "packet",
  requires: (s) => ({
    capabilities: [],
    connectors: [s.connector],
    repository: true,
    pool: "none",
    roles: [],
  }),
  gate: (s) => ({
    kind: "merge",
    decider: s.decider,
    mode: "required",
    on: "pull-request",
    outcomes: ["approve", "sendBack", "reject"],
    operation: "pr.merge",
    risk: "merge",
    // `autoApprove` (ADR 0515) is added with dark factory mode, build plan PR (e).
    delegable: [],
    // `merge` is in ALWAYS_REVIEW (ADR 0008); `autoApprove` decides only under ADR 0515's conditions.
    alwaysReview: true,
  }),
  needsPerson: true,
  reversibility: "irreversible",
  action: () => ({ operation: "pr.merge", risk: "merge", on: "pull-request" }),
  steps: () => [
    { id: "decide", kind: "decision" },
    { id: "act", kind: "check" },
  ],
  // The merge gate on the review packet; approved, the merge through the queue (or directly).
  next: (ctx) => {
    const at = ctx.entry.stageId;
    if (ctx.observations.merged) return { kind: "complete", stageId: at };
    const gated = gateStep(ctx, "gate", { kind: "merge", operation: "pr.merge" }, null, (note) => ({
      kind: "sendBack",
      stageId: at,
      to: "",
      note,
    }));
    if (gated) return gated;
    if (ctx.settings.via === "mergeQueue" && !ctx.observations.queueTurn)
      return { kind: "wait", stageId: at, why: "queue" };
    const merge = latest(ctx.steps, "merge")?.step;
    if (!merge) return { kind: "operation", stageId: at, stepId: "merge", operation: "pr.merge" };
    if (merge.status === "failed") return { kind: "fail", stageId: at, reason: "the merge failed" };
    return { kind: "wait", stageId: at, why: "merge" };
  },
  impact: (before, after, stageId) => {
    const out: ImpactChange[] = deciderImpact(`${stageId}.decider`, before.decider, after.decider);
    if (before.via !== after.via)
      out.push({
        path: `${stageId}.via`,
        class: after.via === "direct" ? "loosens" : "tightens",
        summary: `Merges ${after.via === "direct" ? "directly, not through the queue" : "through the merge queue"}.`,
      });
    if (!same(before.queue, after.queue))
      out.push({
        path: `${stageId}.queue`,
        class: "neutral",
        summary: "Merge queue timing changed.",
      });
    return out;
  },
};
