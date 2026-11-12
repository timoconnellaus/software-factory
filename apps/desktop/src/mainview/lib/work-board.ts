// The Work section's views (spec 41, design WorkBacklog/WorkReady/WorkActive/WorkDone): which items
// each list entry shows, and the board's lanes by stage. Pure, so the tests pin them. The views
// are spec 50's fixed work-management states (backlog, shaping, ready, then released work); stages
// belong to the project's workflow.
import type { OpOutput } from "@software-factory/client/ops";

export type WorkItemSummary = OpOutput<"workItem.list">["items"][number];
export type WorkView = "backlog" | "planning" | "ready" | "active" | "done" | "stopped";

export const ACTIVE = ["running", "waiting", "paused"] as const;

/** Which view a status is in. Queued work is released, so it is in the factory (its first lane). */
export function viewOf(status: string): WorkView {
  if (status === "backlog") return "backlog";
  if (status === "shaping") return "planning";
  if (status === "ready") return "ready";
  if (status === "queued" || (ACTIVE as readonly string[]).includes(status)) return "active";
  return status === "done" ? "done" : "stopped";
}

export const VIEW_LABEL: Record<WorkView, string> = {
  backlog: "Backlog",
  planning: "Planning",
  ready: "Ready",
  active: "In the factory",
  done: "Done",
  stopped: "Stopped",
};

/** `workItem.board`'s counts (per project and status, across the org), tagged with their org. */
export interface BoardCount {
  orgId: string;
  projectId: string;
  status: string;
  n: number;
}

const zero = (): Record<WorkView, number> => ({
  backlog: 0,
  planning: 0,
  ready: 0,
  active: 0,
  done: 0,
  stopped: 0,
});

/** The nested list's counts per view, within the chosen org (and project, when given). */
export function viewCounts(
  counts: BoardCount[],
  opts: { orgId: string | null; projectId?: string | null },
): Record<WorkView, number> {
  const out = zero();
  for (const c of counts) {
    if (opts.orgId !== null && c.orgId !== opts.orgId) continue;
    if (opts.projectId && c.projectId !== opts.projectId) continue;
    out[viewOf(c.status)] += c.n;
  }
  return out;
}

/** A project's open work: everything not yet done or stopped. */
export function openCount(counts: BoardCount[], projectId: string): number {
  return counts
    .filter((c) => c.projectId === projectId && !["done", "stopped"].includes(viewOf(c.status)))
    .reduce((n, c) => n + c.n, 0);
}

/**
 * Where the Work list is: the view and project from `/work`'s search, or the open item's project.
 * A project's page and its board select the project; a view filtered to a project selects the view.
 */
export function workPlace(
  pathname: string,
  search: { view?: WorkView; project?: string },
  projectOfItem: (id: string) => string | null,
): { view: WorkView | null; projectId: string | null } {
  if (pathname === "/work") {
    const onProject = !!search.project && (!search.view || search.view === "active");
    return {
      view: onProject ? null : (search.view ?? "active"),
      projectId: onProject ? (search.project ?? null) : null,
    };
  }
  const itemId = /^\/work\/([^/]+)/.exec(pathname)?.[1];
  if (itemId) return { view: null, projectId: projectOfItem(decodeURIComponent(itemId)) };
  return { view: null, projectId: null };
}

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
  const out = zero();
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
  return {
    label: item.status[0]?.toUpperCase() + item.status.slice(1),
    tone: "neutral",
    needsYou: false,
  };
}
