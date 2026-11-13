import { z } from "zod";
import {
  AUTO_APPROVE_OFF,
  autoApproveImpact,
  autoApproveSettings,
} from "../../policy/auto-approve.ts";
import type { ImpactChange } from "../../policy/impact.ts";
import { same } from "../../policy/impact.ts";
import type { StageType } from "../contract.ts";
import { gateOf, gateStep, latest, RECHECK } from "../reconcile.ts";
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
    /**
     * Dark factory mode (ADR 0515): the merge gate is approved with no person when every condition
     * holds (`autoApproveVerdict`). Off by default; a setting of the workflow, never an override.
     */
    autoApprove: autoApproveSettings.default(AUTO_APPROVE_OFF),
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
    // With `autoApprove` on, the gate is still a pending `merge` action; the factory decides it only
    // under ADR 0515's conditions, in code (`autoApproveVerdict`), never a delegate.
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
    const head = ctx.observations.headSha;
    // An approval the babysitter carried to this head (spec 53): no new gate in this round.
    const carried =
      ctx.observations.carriedApproval && ctx.observations.carriedApproval.headSha === head
        ? head
        : undefined;
    // A person's send-back here isn't a failed attempt (today's Workflow doesn't count it).
    const gated =
      carried && !latest(ctx.steps, "gate")
        ? null
        : gateStep(ctx, "gate", gateOf(ctx.gate), null, (note) => ({
            kind: "sendBack",
            stageId: at,
            to: "",
            note,
            free: true,
          }));
    if (gated) return gated;
    // The approval holds for the head it was given on, as today (`pr.merge` carries `headSha` and
    // refuses a moved head), or for the head the babysitter proved carries the approved change: any
    // other new head is checked again and decided again.
    const approved = carried ?? latest(ctx.steps, "gate")?.step.headSha;
    if (!approved || !head)
      return {
        kind: "fail",
        stageId: at,
        reason: "the merge approval or the PR's head is unknown: it can't be tied to a head",
      };
    if (approved !== head && !carried)
      return {
        kind: "sendBack",
        stageId: at,
        to: RECHECK,
        note: `the head moved from ${approved.slice(0, 7)} to ${head.slice(0, 7)} after the merge was approved`,
        free: true,
      };
    if (ctx.settings.via === "mergeQueue" && !ctx.observations.queueTurn)
      return { kind: "wait", stageId: at, why: "queue" };
    const merge = latest(ctx.steps, "merge")?.step;
    if (!merge) return { kind: "operation", stageId: at, stepId: "merge", operation: "pr.merge" };
    if (merge.status === "failed") return { kind: "fail", stageId: at, reason: "the merge failed" };
    return { kind: "wait", stageId: at, why: "merge" };
  },
  impact: (before, after, stageId) => {
    const out: ImpactChange[] = deciderImpact(`${stageId}.decider`, before.decider, after.decider);
    out.push(...autoApproveImpact(before.autoApprove, after.autoApprove, `${stageId}.autoApprove`));
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
