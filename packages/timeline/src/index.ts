// A work item's event log in words (spec wi-4): one audit entry (workItem.timeline, ADR 0011) in,
// its label, detail, note, actor and dot out. Pure and dependency-free, so the dashboard and the CLI
// read the same. A new operation's wording is added here, once.

/** The fields of a `workItem.timeline` entry the wording reads. */
export interface TimelineEntry {
  operation: string;
  actorType: string;
  actorId: string;
  outcome: string;
  reason: string | null;
  result?: unknown;
}

/** The status a row's dot shows; the dashboard maps it to its `StatusDot`. */
export type Dot = "done" | "running" | "waiting" | "failed" | "idle";

export interface DescribedEntry {
  label: string;
  detail: string | null;
  note: string | null;
  actor: string;
  dot: Dot;
  /** The outcome when it is neither ok nor held (a held call says so in its label); else null. */
  outcome: string | null;
}

export const LABELS: Readonly<Record<string, string>> = {
  "workItem.create": "Work item created",
  "workItem.triage": "Triage",
  "workItem.enterStage": "Stage",
  "workItem.finish": "Finished",
  "workItem.cancel": "Cancelled",
  "spec.propose": "Spec proposed",
  "spec.accept": "Spec accepted",
  "spec.commit": "Spec committed",
  "spec.approve": "Spec approved",
  "spec.requestChanges": "Spec sent back to planning",
  "question.ask": "Questions asked",
  "question.answer": "Question answered",
  "question.acceptDefaults": "Defaults accepted",
  "planning.answer": "Question answered",
  "planning.acceptDefaults": "Defaults accepted",
  "planning.stop": "Planner stopped",
  "planning.pause": "Planner paused",
  "planning.resume": "Planner resumed",
  "planning.finishAlone": "Planner told to finish alone",
  "question.escalate": "Questions escalated",
  "workItem.awaitQuestions": "Waiting on answers",
  "job.enqueue": "Job queued",
  "job.claim": "Job claimed by a runner",
  "run.handBack": "Run handed back",
  "run.release": "Run released",
  "run.expire": "Run expired",
  "branch.ensure": "Branch created",
  "branch.advance": "Branch advanced",
  "pr.open": "PR opened",
  "pr.merge": "Merge",
  "reviewPacket.record": "Review packet recorded",
  "review.merge": "Merge approved",
  "review.sendBack": "Sent back to build",
  "approval.decide": "Approval decided",
  "gate.escalate": "Gate escalated",
  "incident.open": "Factory incident opened",
};

/** The operation in words, or its raw name when the table doesn't know it. */
export function labelOf(operation: string): string {
  return Object.hasOwn(LABELS, operation) ? (LABELS[operation] as string) : operation;
}

/** What an entry's result adds to its label, or null. A result of the wrong shape adds nothing. */
export function detailOf(e: Pick<TimelineEntry, "operation" | "result">): string | null {
  const r: Record<string, unknown> =
    typeof e.result === "object" && e.result !== null ? (e.result as Record<string, unknown>) : {};
  switch (e.operation) {
    case "workItem.triage":
      return (
        [
          typeof r.size === "string" ? `Sized ${r.size}` : null,
          typeof r.reason === "string" ? r.reason : null,
        ]
          .filter(Boolean)
          .join(". ") || null
      );
    case "workItem.enterStage":
      return typeof r.stage === "string" ? `Entered ${r.stage}` : null;
    case "workItem.create":
      return typeof r.outcome === "string" && r.outcome !== "created" ? r.outcome : null;
    case "pr.open":
      return typeof r.prNumber === "number" ? `PR #${r.prNumber}` : null;
    case "question.ask":
      return Array.isArray(r.questionIds) ? `${r.questionIds.length} questions` : null;
    case "spec.commit":
      return typeof r.path === "string" ? r.path : null;
    default:
      return null;
  }
}

/** Who did it: `you` when `me` is the person, `a person`, the agent's id, or `runner <id>`. */
export function actorLabel(e: Pick<TimelineEntry, "actorType" | "actorId">, me?: string): string {
  if (e.actorType === "human") return me !== undefined && e.actorId === me ? "you" : "a person";
  if (e.actorType === "runner") return `runner ${e.actorId}`;
  return e.actorId;
}

export function dotFor(e: Pick<TimelineEntry, "actorType" | "outcome">): Dot {
  if (e.outcome === "ok") return e.actorType === "human" ? "done" : "running";
  if (e.outcome === "review") return "waiting";
  if (e.outcome === "failed" || e.outcome === "denied" || e.outcome === "forbidden")
    return "failed";
  return "idle";
}

/**
 * One entry in words. `me` is the viewer's user id (a person who matches reads as `you`); `gate` is
 * the gate this entry decided, when the caller knows it: a person's decision then shows its note.
 */
export function describeEntry(
  e: TimelineEntry,
  opts: { me?: string; gate?: { note: string | null } | null } = {},
): DescribedEntry {
  const label =
    e.outcome === "review"
      ? `Gate opened: ${labelOf(e.operation)} needs a person`
      : e.operation === "pr.merge" && e.outcome === "ok"
        ? "Merged"
        : labelOf(e.operation);
  // A decision shows the person's note. The gate check's own reason on a successful call ("human",
  // "autonomy policy balanced") is noise; it matters when a call was held, refused or failed.
  const note =
    opts.gate && e.actorType === "human" ? opts.gate.note : e.outcome === "ok" ? null : e.reason;
  return {
    label,
    detail: detailOf(e),
    note: note || null,
    actor: actorLabel(e, opts.me),
    dot: dotFor(e),
    outcome: e.outcome !== "ok" && e.outcome !== "review" ? e.outcome : null,
  };
}
