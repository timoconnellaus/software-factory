// The Inbox's nested list (spec 41, design InboxMerge/InboxQuestion): what waits on you, grouped
// Merges, Specs, Questions, Approvals, then Notices. Each entry has a key, which is what `?item=`
// selects: the work item id for anything on a work item (so `sf://` links and `/?item=` keep
// working), the gate's id for a gate with no item, `protection-<project>` and `setup` for notices.
import type { Inbox, SetupStatus } from "@software-factory/client/ops";
import type { Status } from "@software-factory/ui/components/status-dot";

export type InboxEntry =
  | {
      key: string;
      group: "Merges" | "Specs" | "Approvals";
      kind: "gate";
      gate: Inbox["gates"][number];
    }
  | { key: string; group: "Specs"; kind: "planning"; planning: Inbox["planning"][number] }
  | { key: string; group: "Questions"; kind: "question"; question: Inbox["questions"][number] }
  | { key: string; group: "Approvals"; kind: "release"; flag: Inbox["releaseFlags"][number] }
  | { key: string; group: "Notices"; kind: "protection"; drift: Inbox["protection"][number] }
  | { key: string; group: "Notices"; kind: "setup"; setup: SetupStatus };

export const GROUP_ORDER = ["Merges", "Specs", "Questions", "Approvals", "Notices"] as const;

export function inboxEntries(inbox: Inbox, setup: SetupStatus | null | undefined): InboxEntry[] {
  const seen = new Set<string>();
  const out: InboxEntry[] = [];
  const add = (e: InboxEntry) => {
    if (seen.has(e.key)) return;
    seen.add(e.key);
    out.push(e);
  };
  for (const gate of inbox.gates) {
    const group = gate.kind === "merge" ? "Merges" : gate.kind === "spec" ? "Specs" : "Approvals";
    add({ key: gate.workItemId ?? gate.id, group, kind: "gate", gate });
  }
  for (const planning of inbox.planning) {
    add({ key: planning.workItemId, group: "Specs", kind: "planning", planning });
  }
  for (const question of inbox.questions) {
    // A second question on one item gets its own key, so each can be selected.
    const key = seen.has(question.workItemId) ? question.id : question.workItemId;
    add({ key, group: "Questions", kind: "question", question });
  }
  // Spec 52, Q4: a shaped item whose workflow's shaping changed waits on this person's choice.
  for (const flag of inbox.releaseFlags ?? []) {
    add({ key: flag.workItemId, group: "Approvals", kind: "release", flag });
  }
  for (const drift of inbox.protection) {
    add({ key: `protection-${drift.projectId}`, group: "Notices", kind: "protection", drift });
  }
  if (setup && !setup.complete) add({ key: "setup", group: "Notices", kind: "setup", setup });
  return GROUP_ORDER.flatMap((g) => out.filter((e) => e.group === g));
}

/** The entry `?item=` names, else the first one. Null when nothing waits. */
export function selectedEntry(entries: InboxEntry[], item: string | undefined): InboxEntry | null {
  return entries.find((e) => e.key === item) ?? entries[0] ?? null;
}

/** The list row's title and the line under it. */
export function entryText(
  e: InboxEntry,
  numberOf: (workItemId: string) => number | null,
): { title: string; sub: string; status: Status } {
  const prefix = (id: string | null) => {
    const n = id ? numberOf(id) : null;
    return n ? `#${n} ` : "";
  };
  switch (e.kind) {
    case "gate":
      return {
        title: `${prefix(e.gate.workItemId)}${e.gate.title}`,
        sub:
          e.gate.kind === "merge"
            ? "Ready to merge"
            : e.gate.kind === "spec"
              ? "Spec ready for your approval"
              : `Approve ${e.gate.operation}`,
        status: "waiting",
      };
    case "planning":
      return {
        title: `#${e.planning.number} ${e.planning.title}`,
        sub: e.planning.atGate ? "Spec ready for your approval" : "Planning is ready",
        status: e.planning.atGate ? "waiting" : "running",
      };
    case "question":
      return {
        title: `${prefix(e.question.workItemId)}${e.question.prompt}`,
        sub: e.question.irreversible ? "Irreversible" : "Blocks the work",
        status: "waiting",
      };
    case "release":
      return {
        title: `#${e.flag.number} ${e.flag.title}`,
        sub: "Its workflow's shaping changed: choose before release",
        status: "waiting",
      };
    case "protection":
      return {
        title: `Protection on ${e.drift.branch} changed`,
        sub: e.drift.name,
        status: "failed",
      };
    case "setup": {
      const done = e.setup.steps.filter((s) => s.done).length;
      return {
        title: "Finish setup",
        sub: `${done} of ${e.setup.steps.length} done`,
        status: "waiting",
      };
    }
  }
}
