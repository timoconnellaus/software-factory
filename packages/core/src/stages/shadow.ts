// Shadow mode (spec 52 PR (c), ADR 0511 §7): the reconciler runs beside today's Workflow and drives
// nothing. At every transition the Workflow makes (`workItem.enterStage`, `workItem.finish`), the
// engine rebuilds the item's snapshot as it was just before, asks `reconcile()` what comes next, and
// records that next to what the Workflow did. Pure; the engine loads and stores.
//
// What is compared: stage transitions (each stage entered or skipped, send-backs, the end at Done).
// Not yet: steps inside a stage (jobs, gates, CI waits), slot steps (`agent-check`, `decision`, which
// today run inside the build and verify lanes) and an item failing or being rejected (that depends on
// retry counts and a person's decision, which today's stage history doesn't record).
import { type ItemSnapshot, type ReconcileAction, reconcile, sendBackTo } from "./reconcile.ts";
import { stageType } from "./registry.ts";
import type { WorkflowDefinition } from "./workflow.ts";

/** A `core_stages` row, oldest first. */
export interface StageRow {
  stage: string;
  status: "active" | "done" | "skipped" | "sent_back" | "failed" | "cancelled";
}

/** One transition the Workflow made, in the order it made them. */
export type ObservedTransition =
  | { kind: "skip"; stage: string }
  | { kind: "enter"; stage: string }
  | { kind: "end"; status: "done" };

export interface ShadowComparison {
  observed: string;
  predicted: string;
  agrees: boolean;
}

/** The stages today's history records as stages: the definition without its slot steps. */
export function shadowDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return { ...def, stages: def.stages.filter((s) => !stageType(s.type)?.small) };
}

/** Today's stage rows as stage entries. A failed or sent-back stage goes where the reconciler sends it. */
export function entriesFrom(
  def: WorkflowDefinition,
  rows: readonly StageRow[],
): ItemSnapshot["stages"] {
  const ids = new Set(def.stages.map((s) => s.id));
  const out: ItemSnapshot["stages"][number][] = [];
  for (const r of rows) {
    if (!ids.has(r.stage) || r.status === "cancelled") continue;
    const round = out.filter((e) => e.stageId === r.stage).length + 1;
    if (r.status === "failed" || r.status === "sent_back") {
      // A failed build is retried (a new row of the same stage); anything else goes back to the work.
      const inst = def.stages.find((s) => s.id === r.stage);
      const builds = inst ? stageType(inst.type)?.produces.includes("git-head") : false;
      const to = builds ? r.stage : sendBackTo(def, r.stage);
      out.push({ stageId: r.stage, round, typeVersion: 1, status: "sent_back", note: `to:${to}` });
      continue;
    }
    out.push({ stageId: r.stage, round, typeVersion: 1, status: r.status });
  }
  return out;
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
    default:
      return `${a.kind} ${a.stageId}`;
  }
}

function saw(t: ObservedTransition): string {
  return t.kind === "end" ? `end ${t.status}` : `${t.kind} ${t.stage}`;
}

/**
 * Each transition the Workflow made, against what the reconciler predicted from the stage history
 * just before it. `before` is the history before the first of `observed`; each observed transition
 * is applied before predicting the next. The engine's `done` stage is the end.
 */
export function shadowCompare(
  definition: WorkflowDefinition,
  item: ItemSnapshot["item"],
  before: readonly StageRow[],
  observed: readonly ObservedTransition[],
): ShadowComparison[] {
  const def = shadowDefinition(definition);
  const rows = [...before];
  const out: ShadowComparison[] = [];
  for (const raw of observed) {
    const t: ObservedTransition =
      raw.kind === "enter" && raw.stage === "done" ? { kind: "end", status: "done" } : raw;
    // The stage the Workflow just left is closed in `rows` already; an entered stage's entry closes
    // when the next transition comes, so it is active until then.
    const open = rows.at(-1);
    const snapshot: ItemSnapshot = {
      item,
      definition: def,
      stages: entriesFrom(
        def,
        open?.status === "active" ? [...rows.slice(0, -1), { ...open, status: "done" }] : rows,
      ),
      steps: [],
      observations: {},
    };
    // Today's history records a skip for a stage the definition doesn't have (an attached PR's
    // spec and build): the reconciler would do nothing there, which is the same thing.
    const absent = t.kind === "skip" && !def.stages.some((st) => st.id === t.stage);
    const predicted = absent ? `skip ${t.stage}` : said(reconcile(snapshot));
    const seen = saw(t);
    out.push({ observed: seen, predicted, agrees: predicted === seen });
    if (t.kind === "skip") rows.push({ stage: t.stage, status: "skipped" });
    else if (t.kind === "enter") rows.push({ stage: t.stage, status: "active" });
  }
  return out;
}
