// The timeline (spec 13): every entry is a row of the audit journal (workItem.timeline), nothing
// stored separately. Gate decisions show how long the gate was open.
import { type Status, StatusDot } from "@software-factory/ui/components/status-dot";
import { clock, duration } from "#/lib/format";
import type { TimelineEntry, WorkItemDetail } from "#/lib/ops";

const LABELS: Record<string, string> = {
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

function detailOf(e: TimelineEntry): string | null {
  const r = (e.result ?? {}) as Record<string, unknown>;
  switch (e.operation) {
    case "workItem.triage":
      return [
        typeof r.size === "string" ? `Sized ${r.size}` : null,
        typeof r.reason === "string" ? r.reason : null,
      ]
        .filter(Boolean)
        .join(". ");
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

function actorLabel(e: TimelineEntry, me: string): string {
  if (e.actorType === "human") return e.actorId === me ? "you" : "a person";
  if (e.actorType === "agent") return e.actorId;
  if (e.actorType === "runner") return `runner ${e.actorId}`;
  return e.actorId;
}

function dotFor(e: TimelineEntry): Status {
  if (e.outcome === "ok") return e.actorType === "human" ? "done" : "running";
  if (e.outcome === "review") return "waiting";
  if (e.outcome === "failed" || e.outcome === "denied" || e.outcome === "forbidden")
    return "failed";
  return "idle";
}

const DECISION_KIND: Record<string, string> = {
  "spec.approve": "spec",
  "spec.requestChanges": "spec",
  "review.merge": "merge",
  "review.sendBack": "merge",
  "approval.decide": "approval",
};

/** The gate an entry decided: by its pending action id, else the gate of that kind it closed. */
function gateFor(e: TimelineEntry, gates: WorkItemDetail["gates"]) {
  if (e.pendingActionId) return gates.find((g) => g.id === e.pendingActionId);
  const kind = DECISION_KIND[e.operation];
  if (!kind || e.outcome !== "ok") return undefined;
  return gates.find(
    (g) =>
      g.kind === kind &&
      g.decidedBy === e.actorId &&
      g.decidedAt !== null &&
      Math.abs(Date.parse(g.decidedAt) - Date.parse(e.at)) < 5_000,
  );
}

export function Timeline({
  entries,
  gates,
  me,
}: {
  entries: TimelineEntry[];
  gates: WorkItemDetail["gates"];
  me: string;
}) {
  if (entries.length === 0) {
    return <div className="text-muted-foreground text-sm">Nothing has happened yet.</div>;
  }
  return (
    <ol className="grid gap-3" data-testid="timeline">
      {entries.map((e) => {
        const gate = gateFor(e, gates);
        const gateTime =
          gate?.decidedAt && e.actorType === "human"
            ? duration(Date.parse(gate.decidedAt) - Date.parse(gate.createdAt))
            : null;
        const detail = detailOf(e);
        // A decision shows the person's note; the gate check's own reason (e.g. "human") adds nothing.
        // The gate check's reason on a successful call ("human", "autonomy policy balanced") is
        // noise; it matters when a call was held, refused or failed.
        const note =
          gate && e.actorType === "human" ? gate.note : e.outcome === "ok" ? null : e.reason;
        const label =
          e.outcome === "review"
            ? `Gate opened: ${LABELS[e.operation] ?? e.operation} needs a person`
            : e.operation === "pr.merge" && e.outcome === "ok"
              ? "Merged"
              : (LABELS[e.operation] ?? e.operation);
        return (
          <li key={e.id} className="flex gap-3 text-sm" data-operation={e.operation}>
            <StatusDot status={dotFor(e)} className="mt-1.5" />
            <div className="min-w-0">
              <b className="font-medium">{label}</b>{" "}
              <span className="text-muted-foreground text-xs">
                · {actorLabel(e, me)} · {clock(e.at)}
                {gateTime ? ` · gate time ${gateTime}` : ""}
                {e.outcome !== "ok" && e.outcome !== "review" ? ` · ${e.outcome}` : ""}
              </span>
              {(detail || note) && (
                <div className="text-muted-foreground">
                  {[detail, note].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
