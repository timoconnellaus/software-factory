// The reconciler in shadow, read side (spec 52 PR (c), ADR 0511 §7): what it predicted at each of an
// item's transitions, and the agreement streak the switch-over waits for (20 finished items in a row
// with no divergence, spec 52 Q14).
import { z } from "zod";
import { defineOperation } from "../operation.ts";
import { requireWorkItem, workItemId } from "./shared.ts";

/** The switch-over PR is opened only once the streak reaches this (spec 52, Q14). */
export const AGREEMENT_STREAK_TARGET = 20;

export const reconcileReport = defineOperation({
  name: "reconcile.report",
  description:
    "The shadow reconciler's report for one work item (spec 52 PR (c)): each stage transition the Workflow made, what the reconciler predicted, and whether they agree. It drives nothing. Members only.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ workItemId }),
  output: z.object({
    transitions: z.array(
      z.object({
        at: z.string(),
        observed: z.string(),
        predicted: z.string(),
        agrees: z.boolean(),
      }),
    ),
    divergences: z.number(),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    // core_reconcile_shadow_item_idx; an item has tens of transitions.
    const rows = await ctx.db
      .selectFrom("core_reconcile_shadow")
      .select(["observed", "predicted", "agrees", "created_at"])
      .where("work_item_id", "=", w.id)
      .orderBy("created_at")
      .orderBy("seq")
      .limit(500)
      .execute();
    return {
      transitions: rows.map((r) => ({
        at: r.created_at,
        observed: r.observed,
        predicted: r.predicted,
        agrees: r.agrees === 1,
      })),
      divergences: rows.filter((r) => r.agrees !== 1).length,
    };
  },
});

export const reconcileStreak = defineOperation({
  name: "reconcile.streak",
  description: `The shadow reconciler's agreement streak for an org (spec 52 PR (c)): how many items in a row, newest first, reached Done with every stage transition predicted. The switch-over waits for ${AGREEMENT_STREAK_TARGET}; any divergence resets it. Lists the last diverging item. Members only.`,
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.object({
    streak: z.number(),
    target: z.number(),
    finished: z.number(),
    lastDivergence: z
      .object({ workItemId: z.string(), finishedAt: z.string(), divergences: z.number() })
      .nullable(),
  }),
  async handler(input, ctx) {
    // core_reconcile_items_org_idx, newest first, bounded: the streak needs only the run up to the
    // first divergence.
    const rows = await ctx.db
      .selectFrom("core_reconcile_items")
      .select(["work_item_id", "divergences", "finished_at"])
      .where("org_id", "=", input.orgId)
      .orderBy("finished_at", "desc")
      .limit(100)
      .execute();
    const firstBad = rows.findIndex((r) => r.divergences > 0);
    const bad = firstBad >= 0 ? rows[firstBad] : undefined;
    return {
      streak: firstBad < 0 ? rows.length : firstBad,
      target: AGREEMENT_STREAK_TARGET,
      finished: rows.length,
      lastDivergence: bad
        ? {
            workItemId: bad.work_item_id,
            finishedAt: bad.finished_at,
            divergences: bad.divergences,
          }
        : null,
    };
  },
});
