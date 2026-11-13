// The reconciler in shadow, read side (spec 52 PR (c), ADR 0511 §7): what it predicted over an ended
// item's history, and the agreement streak the switch-over waits for (20 ended items in a row with
// no divergence, spec 52 Q14). The streak is not a number until the comparison covers everything
// (`SHADOW_NOT_COMPARED` is empty), which it is now: stages, jobs and attempts, gates and who
// decided them, send-back targets and rounds, retries, slot steps and every kind of end.
import { z } from "zod";
import { defineOperation } from "../operation.ts";
import { COVERAGE, KNOWN_GAPS, SHADOW_NOT_COMPARED, type ShadowVerdict } from "../stages/shadow.ts";
import { requireWorkItem, workItemId } from "./shared.ts";

/** The switch-over PR is opened only once the streak reaches this (spec 52, Q14). */
export const AGREEMENT_STREAK_TARGET = 20;

export const reconcileReport = defineOperation({
  name: "reconcile.report",
  description:
    "The shadow reconciler's report for one ended work item (spec 52 PR (c)): each stage transition the Workflow made, what the reconciler predicted, whether they agree, what wasn't compared, and the known differences it hit by name (such as `queue-head-moved`); each counts as a divergence. Null until the shadow pass has read the item. It drives nothing. Members only.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ workItemId }),
  output: z.object({
    report: z
      .object({
        ended: z.string(),
        finishedAt: z.string(),
        transitions: z.array(
          z.object({ observed: z.string(), predicted: z.string(), agrees: z.boolean() }),
        ),
        uncompared: z.array(z.string()),
        known: z.array(z.object({ reason: z.string(), note: z.string() })),
        equivalences: z.array(z.object({ reason: z.string(), note: z.string() })),
        covers: z.array(z.string()),
        divergences: z.number(),
      })
      .nullable(),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    // A point read by primary key.
    const row = await ctx.db
      .selectFrom("core_reconcile_items")
      .select(["ended", "report", "finished_at"])
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    if (!row) return { report: null };
    const verdict = JSON.parse(row.report) as ShadowVerdict;
    return {
      report: {
        ended: row.ended,
        finishedAt: row.finished_at,
        transitions: verdict.transitions,
        uncompared: verdict.uncompared,
        // Verdicts written before known differences were named carry none.
        known: verdict.known ?? [],
        equivalences: verdict.equivalences ?? [],
        covers: verdict.covers ?? [],
        divergences: verdict.divergences,
      },
    };
  },
});

export const reconcileStreak = defineOperation({
  name: "reconcile.streak",
  description: `The shadow reconciler's agreement streak for an org (spec 52 PR (c)): how many ended items in a row, newest first, agreed with no divergence. The switch-over waits for ${AGREEMENT_STREAK_TARGET}; any divergence resets it. Beside the number, which of the scenarios the switch-over needs (a verify that fails, slot and merge-gate send-backs, retries past the limit, changes requested at the spec gate, a parked item, a cancel, a carried approval, an attached PR, an incident) the streak's items covered, and which are missing. The comparison covers stages, jobs and attempts, gates and who decided them, send-backs, retries, slot steps and every kind of end; were any of it left out, it would report "comparison incomplete" and what is missing, never a number. Members only.`,
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("incomplete"),
      message: z.string(),
      missing: z.array(z.string()),
      target: z.number(),
    }),
    z.object({
      status: z.literal("comparable"),
      streak: z.number(),
      target: z.number(),
      ended: z.number(),
      lastDivergence: z
        .object({ workItemId: z.string(), finishedAt: z.string(), divergences: z.number() })
        .nullable(),
      /**
       * Which of the scenarios the switch-over needs (`COVERAGE`) the items in the streak exercised
       * and agreed on, and which none has yet.
       */
      coverage: z.object({ covered: z.array(z.string()), missing: z.array(z.string()) }),
      /** What the reconciler doesn't model yet: the switch-over waits for none. */
      knownGaps: z.array(z.string()),
      /** The streak reached the target, every scenario is covered, and there are no known gaps. */
      switchOverReady: z.boolean(),
    }),
  ]),
  async handler(input, ctx) {
    if (SHADOW_NOT_COMPARED.length > 0) {
      return {
        status: "incomplete" as const,
        message: `comparison incomplete: ${SHADOW_NOT_COMPARED.join("; ")}`,
        missing: [...SHADOW_NOT_COMPARED],
        target: AGREEMENT_STREAK_TARGET,
      };
    }
    // core_reconcile_items_org_idx, newest first, bounded: the streak needs only the run up to the
    // first divergence.
    const rows = await ctx.db
      .selectFrom("core_reconcile_items")
      .select(["work_item_id", "divergences", "finished_at", "report"])
      .where("org_id", "=", input.orgId)
      .orderBy("finished_at", "desc")
      .limit(100)
      .execute();
    const firstBad = rows.findIndex((r) => r.divergences > 0);
    const bad = firstBad >= 0 ? rows[firstBad] : undefined;
    const streak = firstBad < 0 ? rows : rows.slice(0, firstBad);
    const covered = new Set<string>();
    for (const r of streak) {
      try {
        for (const c of (JSON.parse(r.report) as ShadowVerdict).covers ?? []) covered.add(c);
      } catch {
        // An unreadable report covers nothing.
      }
    }
    return {
      status: "comparable" as const,
      streak: streak.length,
      target: AGREEMENT_STREAK_TARGET,
      ended: rows.length,
      lastDivergence: bad
        ? {
            workItemId: bad.work_item_id,
            finishedAt: bad.finished_at,
            divergences: bad.divergences,
          }
        : null,
      coverage: {
        covered: COVERAGE.filter((c) => covered.has(c)),
        missing: COVERAGE.filter((c) => !covered.has(c)),
      },
      knownGaps: [...KNOWN_GAPS],
      switchOverReady:
        streak.length >= AGREEMENT_STREAK_TARGET &&
        COVERAGE.every((c) => covered.has(c)) &&
        (KNOWN_GAPS as readonly string[]).length === 0,
    };
  },
});
