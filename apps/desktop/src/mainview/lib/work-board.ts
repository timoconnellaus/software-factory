// The Work section's views (spec 41, design WorkActive/WorkDone): which items each list entry
// shows, and the board's lanes by stage. Pure, so the tests pin them. Lanes are the factory's own
// stages; a project's workflow lanes (who decides each) come with spec 50 (spec 41, slice 2).
import type { OpOutput } from "@software-factory/client/ops";

export type WorkItemSummary = OpOutput<"workItem.list">["items"][number];
export type WorkView = "active" | "done" | "stopped";

export const ACTIVE = ["running", "waiting", "paused"] as const;

export function viewOf(status: string): WorkView {
  if ((ACTIVE as readonly string[]).includes(status)) return "active";
  return status === "done" ? "done" : "stopped";
}

export const VIEW_LABEL: Record<WorkView, string> = {
  active: "In the factory",
  done: "Done",
  stopped: "Stopped",
};

/** The items a list entry shows: one view, optionally one project, within the chosen org. */
export function workItemsFor(
  items: WorkItemSummary[],
  opts: { view: WorkView; projectId?: string | undefined; orgId: string | null },
): WorkItemSummary[] {
  return items.filter(
    (i) =>
      viewOf(i.status) === opts.view &&
      (!opts.projectId || i.projectId === opts.projectId) &&
      (opts.orgId === null || i.orgId === opts.orgId),
  );
}

export function countsByView(items: WorkItemSummary[], orgId: string | null) {
  const out: Record<WorkView, number> = { active: 0, done: 0, stopped: 0 };
  for (const i of items) if (orgId === null || i.orgId === orgId) out[viewOf(i.status)]++;
  return out;
}

/** The board's lanes, in the factory's order. Done and stopped items have no lane. */
export const LANES = ["intake", "triage", "spec", "build", "verify", "merge"] as const;
export type Lane = (typeof LANES)[number];

export function lanes(items: WorkItemSummary[]): { stage: Lane; items: WorkItemSummary[] }[] {
  return LANES.map((stage) => ({ stage, items: items.filter((i) => i.stage === stage) }));
}

/** A board card's chip: what the item is doing, and whether it needs you. */
export function cardState(
  item: Pick<WorkItemSummary, "id" | "status">,
  needsYou: Set<string>,
): { label: string; tone: "amber" | "blue" | "neutral" | "green"; needsYou: boolean } {
  if (needsYou.has(item.id)) return { label: "Needs you", tone: "amber", needsYou: true };
  if (item.status === "running") return { label: "Working", tone: "blue", needsYou: false };
  if (item.status === "waiting") return { label: "Waiting", tone: "neutral", needsYou: false };
  if (item.status === "paused") return { label: "Paused", tone: "neutral", needsYou: false };
  if (item.status === "done") return { label: "Done", tone: "green", needsYou: false };
  return { label: item.status[0]?.toUpperCase() + item.status.slice(1), tone: "neutral", needsYou: false };
}
