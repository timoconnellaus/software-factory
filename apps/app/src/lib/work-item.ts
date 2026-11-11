// Pure helpers for the work item detail page (spec 13).
import type { Status } from "@software-factory/ui/components/status-dot";
import type { WorkItemDetail } from "./ops.ts";

/** The pipeline V1 runs (spec 02). `done` is the end state, not a step. */
export const PIPELINE = ["intake", "triage", "spec", "build", "verify", "merge"] as const;
export type StepState = "done" | "now" | "skipped" | "todo" | "failed";

export interface Step {
  stage: (typeof PIPELINE)[number];
  state: StepState;
  /** For a skipped spec: the reason triage logged (criterion 6). */
  reason: string | null;
  gate: boolean;
}

export function stageSteps(detail: WorkItemDetail): Step[] {
  const { item, stages } = detail;
  const current = PIPELINE.indexOf(item.stage as (typeof PIPELINE)[number]);
  const finished = item.stage === "done";
  const failed = ["failed", "rejected", "cancelled"].includes(item.status);
  return PIPELINE.map((stage, i) => {
    const ran = stages.filter((s) => s.stage === stage);
    const skipped =
      (stage === "spec" && item.specRequired === false) || ran.some((s) => s.status === "skipped");
    let state: StepState;
    if (skipped) state = "skipped";
    else if (finished || (current >= 0 && i < current)) state = "done";
    else if (i === current) state = failed ? "failed" : "now";
    else state = "todo";
    return {
      stage,
      state,
      reason: skipped
        ? (ran.find((s) => s.reason)?.reason ?? item.specDecisionReason ?? "skipped")
        : null,
      gate: stage === "spec" || stage === "merge",
    };
  });
}

/** Summed open time of the gates the viewer decided on this item (criterion 3), in ms. */
export function yourTime(detail: WorkItemDetail, me: string): number {
  return detail.gates
    .filter((g) => g.decidedBy === me && g.decidedAt)
    .reduce((ms, g) => ms + (Date.parse(g.decidedAt as string) - Date.parse(g.createdAt)), 0);
}

/** Summed run time on runners, in ms (a running run counts up to now). */
export function agentTime(detail: WorkItemDetail, now = Date.now()): number {
  return detail.runs.reduce(
    (ms, r) => ms + ((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt)),
    0,
  );
}

/** The item's status dot: waiting when something needs a person. */
export function statusOf(detail: WorkItemDetail): Status {
  const { item } = detail;
  if (
    detail.gates.some((g) => g.status === "pending") ||
    detail.questions.some((q) => q.status === "open")
  )
    return "waiting";
  if (item.status === "done") return "done";
  if (["failed", "rejected"].includes(item.status)) return "failed";
  if (item.status === "cancelled" || item.status === "paused") return "idle";
  return "running";
}
