// The timeline (spec 13): every entry is a row of the audit journal (workItem.timeline), nothing
// stored separately. Gate decisions show how long the gate was open. The wording (labels, details,
// notes, actors, dots) is @software-factory/timeline's, shared with `sf timeline` (spec wi-4); this
// file keeps the layout and the gate matching. Ported from sf-app for spec 40 M3.
import { clock, duration } from "@software-factory/client/format";
import type { TimelineEntry, WorkItemDetail } from "@software-factory/client/ops";
import { describeEntry } from "@software-factory/timeline";
import { StatusDot } from "@software-factory/ui/components/status-dot";

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
        const { label, detail, note, actor, dot, outcome } = describeEntry(e, { me, gate });
        return (
          <li key={e.id} className="flex gap-3 text-sm" data-operation={e.operation}>
            <StatusDot status={dot} className="mt-1.5" />
            <div className="min-w-0">
              <b className="font-medium">{label}</b>{" "}
              <span className="text-muted-foreground text-xs">
                · {actor} · {clock(e.at)}
                {gateTime ? ` · gate time ${gateTime}` : ""}
                {outcome ? ` · ${outcome}` : ""}
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
