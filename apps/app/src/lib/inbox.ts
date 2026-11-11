import type { Inbox } from "./ops.ts";

export interface InboxGroup {
  projectId: string;
  gates: Inbox["gates"];
  questions: Inbox["questions"];
  waitingBuilds: number;
}

/** Cards grouped by project (spec 12), with each project's WIP hold. Each card appears once. */
export function groupByProject(inbox: Inbox): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  const get = (projectId: string) => {
    let g = groups.get(projectId);
    if (!g) {
      g = { projectId, gates: [], questions: [], waitingBuilds: 0 };
      groups.set(projectId, g);
    }
    return g;
  };
  for (const gate of inbox.gates) get(gate.projectId ?? "").gates.push(gate);
  for (const q of inbox.questions) get(q.projectId).questions.push(q);
  for (const hold of inbox.wipHolds) get(hold.projectId).waitingBuilds = hold.waitingBuilds;
  return [...groups.values()];
}
