// Shadow mode (spec 52 PR (c), ADR 0511 §7): the reconciler runs beside today's Workflow and drives
// nothing. Once an item has ended, the engine's shadow pass reads the stage history the Workflow
// already wrote and asks `reconcile()`, transition by transition, what it would have done. Pure; the
// engine loads and stores, off the Workflow's path.
//
// What is compared today: the stage order and skips, and an item's end at Done. What is NOT compared
// yet is listed in `SHADOW_NOT_COMPARED`, and every item counts each of those as a divergence, so no
// item can agree by what was never looked at. `reconcile.streak` reports "comparison incomplete"
// until that list is empty.
import {
  type ItemSnapshot,
  type ReconcileAction,
  reconcile,
  type StageEntry,
} from "./reconcile.ts";
import { stageType } from "./registry.ts";
import type { WorkflowDefinition } from "./workflow.ts";

/** Everything the comparison must cover before the agreement streak means anything (spec 52 Q14). */
export const SHADOW_REQUIRED = [
  "stage order and skips",
  "jobs and attempts",
  "gates opened and decided, and by whom",
  "send-back targets and rounds",
  "retry counts",
  "slot steps",
  "the end of every item (failed, rejected, cancelled and incomplete, not only Done)",
] as const;
export type ShadowAspect = (typeof SHADOW_REQUIRED)[number];

/** What `shadowVerdict` compares today. */
export const SHADOW_COMPARED: readonly ShadowAspect[] = ["stage order and skips"];

/** What it doesn't yet: each is a divergence on every item, and the streak can't be counted. */
export const SHADOW_NOT_COMPARED: readonly ShadowAspect[] = SHADOW_REQUIRED.filter(
  (a) => !SHADOW_COMPARED.includes(a),
);

/**
 * Differences between today's Workflow and the reconciler that are known and not yet settled. Each
 * is reported under its own name, not as a generic divergence, and counts as a divergence until it
 * is settled, so no item with one can extend the streak.
 */
export const KNOWN_DIFFERENCES = {
  /**
   * The head moved in the merge queue (ADR 0330): today's Workflow merges the default branch into the
   * branch, waits for CI on the new head and lands with the same approval; the reconciler's publish
   * stage sends the item back to Checks and reopens the merge gate. Spec 53 (the babysitter, PRs #103
   * to #105) changes exactly this; the two settle together.
   */
  "queue-head-moved":
    "the head moved in the merge queue: today's Workflow merged the default branch in and landed with the same approval; the reconciler would go back to Checks and reopen the gate (to settle with spec 53)",
} as const;
export type KnownDifference = keyof typeof KNOWN_DIFFERENCES;

/** What the shadow pass observed about an item besides its stage rows. */
export interface ShadowObserved {
  /** The merge queue brought the head up to date (a review packet carried to the new head). */
  queueHeadMoved?: boolean;
}

/** A `core_stages` row, oldest first. */
export interface StageRow {
  stage: string;
  status: "active" | "done" | "skipped" | "sent_back" | "failed" | "cancelled";
}

/** How the item ended (`core_work_items.status` once closed). */
export type ItemEnd = "done" | "failed" | "rejected" | "cancelled";

export interface ShadowComparison {
  observed: string;
  predicted: string;
  agrees: boolean;
}

export interface ShadowVerdict {
  transitions: ShadowComparison[];
  /** Aspects not compared for this item; each counts as a divergence. */
  uncompared: string[];
  /** Known differences this item hit, by name (`KNOWN_DIFFERENCES`); each counts as a divergence. */
  known: { reason: KnownDifference; note: string }[];
  /**
   * Transitions that disagree, plus every uncompared aspect and every known difference. Zero only
   * when all was compared and nothing differed.
   */
  divergences: number;
}

/** The stages today's history records as stages: the definition without its slot steps. */
export function shadowDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return { ...def, stages: def.stages.filter((s) => !stageType(s.type)?.small) };
}

function said(a: ReconcileAction): string {
  switch (a.kind) {
    case "enter":
    case "skip":
      return `${a.kind} ${a.stageId}`;
    case "done":
      return "end done";
    case "fail":
      return "end failed";
    case "reject":
      return "end rejected";
    case "wait":
      return `wait ${a.why}`;
    case "repin":
      return `repin v${a.version}`;
    case "flag":
      return `flag ${a.stageId ?? "-"}`;
    default:
      return `${a.kind} ${a.stageId}`;
  }
}

const NOT_COMPARED_TARGET = "not compared: a send-back's target (needs the steps)";

/**
 * An ended item's stage history against what the reconciler predicts at each transition, from the
 * history just before it. A send-back's target is today's (the next stage the history entered),
 * never the reconciler's own guess, and the transition after a send-back isn't compared: deciding
 * it needs the steps, which the snapshot doesn't have yet. An end other than Done isn't compared.
 */
export function shadowVerdict(
  definition: WorkflowDefinition,
  item: ItemSnapshot["item"],
  rows: readonly StageRow[],
  end: ItemEnd,
  observed: ShadowObserved = {},
): ShadowVerdict {
  const def = shadowDefinition(definition);
  const ids = new Set(def.stages.map((s) => s.id));
  const history = rows.filter(
    (r) => r.stage !== "intake" && r.stage !== "done" && r.status !== "cancelled",
  );
  const entries: StageEntry[] = [];
  const transitions: ShadowComparison[] = [];
  const predict = () =>
    said(reconcile({ item, definition: def, stages: entries, steps: [], observations: {} }));
  let afterSendBack = false;
  history.forEach((r, i) => {
    const observed = r.status === "skipped" ? `skip ${r.stage}` : `enter ${r.stage}`;
    if (afterSendBack) {
      transitions.push({ observed, predicted: NOT_COMPARED_TARGET, agrees: false });
      afterSendBack = false;
    } else if (r.status === "skipped" && !ids.has(r.stage)) {
      // Today's history records a skip for a stage the definition doesn't have (an attached PR's
      // spec and build): the reconciler does nothing there, which is the same thing.
      transitions.push({ observed, predicted: observed, agrees: true });
    } else {
      const predicted = predict();
      transitions.push({ observed, predicted, agrees: predicted === observed });
    }
    if (!ids.has(r.stage)) return;
    const round = entries.filter((e) => e.stageId === r.stage).length + 1;
    const last = i === history.length - 1;
    if ((r.status === "failed" || r.status === "sent_back") && !(last && end !== "done")) {
      // Back to the stage today's history entered next. `free`: retry counts aren't compared yet,
      // so the reconciler's own count mustn't end the item where today's didn't.
      const next = history.slice(i + 1).find((x) => ids.has(x.stage))?.stage ?? r.stage;
      entries.push({
        stageId: r.stage,
        round,
        typeVersion: 1,
        status: "sent_back",
        note: `to:${next}`,
        free: true,
      });
      afterSendBack = true;
      return;
    }
    entries.push({
      stageId: r.stage,
      round,
      typeVersion: 1,
      status: r.status === "skipped" ? "skipped" : "done",
    });
  });
  if (end === "done") {
    const predicted = afterSendBack ? NOT_COMPARED_TARGET : predict();
    transitions.push({ observed: "end done", predicted, agrees: predicted === "end done" });
  } else {
    transitions.push({
      observed: `end ${end}`,
      predicted: "not compared: an end other than Done (needs the steps)",
      agrees: false,
    });
  }
  const uncompared = [...SHADOW_NOT_COMPARED];
  const known: ShadowVerdict["known"] = [];
  if (observed.queueHeadMoved)
    known.push({ reason: "queue-head-moved", note: KNOWN_DIFFERENCES["queue-head-moved"] });
  return {
    transitions,
    uncompared,
    known,
    divergences: transitions.filter((t) => !t.agrees).length + uncompared.length + known.length,
  };
}
