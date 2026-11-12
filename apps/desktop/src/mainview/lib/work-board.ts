// The Work section's views (spec 41, design WorkBacklog/WorkReady/WorkActive/WorkDone): which items
// each list entry shows, and the board's lanes by stage. Pure, so the tests pin them. The views
// are spec 50's fixed work-management states (backlog, shaping, ready, then released work, then
// done with its outcome); stages belong to the project's workflow.
import type { BoardItem, OpOutput } from "@software-factory/client/ops";

export type WorkItemSummary = OpOutput<"workItem.list">["items"][number];
export type WorkView = "backlog" | "planning" | "ready" | "active" | "done";

export const ACTIVE = ["running", "waiting", "paused"] as const;

/** Which view a status is in. Queued work is released, so it is in the factory (its first lane). */
export function viewOf(status: string): WorkView {
  if (status === "backlog") return "backlog";
  if (status === "shaping") return "planning";
  if (status === "ready") return "ready";
  if (status === "queued" || (ACTIVE as readonly string[]).includes(status)) return "active";
  // Done is everything that left the factory, with its outcome (design WorkDone).
  return "done";
}

export const VIEW_LABEL: Record<WorkView, string> = {
  backlog: "Backlog",
  planning: "Planning",
  ready: "Ready",
  active: "In the factory",
  done: "Done",
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

/** A project's open work: everything not yet finished. */
export function openCount(counts: BoardCount[], projectId: string): number {
  return counts
    .filter((c) => c.projectId === projectId && viewOf(c.status) !== "done")
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

/** An item on the board: `workItem.board`'s, with the org its read came from. */
export type ActiveItem = BoardItem & { orgId: string };

export interface Lane {
  /** `queued`, or the stage's name as the server reports it. */
  key: string;
  label: string;
  phase: "queued" | "shaping" | "delivery";
  items: ActiveItem[];
}

/**
 * The board's lanes (spec 50). Queued is the one lane every workflow has (released, not yet
 * pulled), so it is always first. The rest are the stages the server reports on the items, in
 * their phase (shaping before delivery); within a phase, in the order `STAGE_LABEL` lists the
 * stages it knows, and any other stage after them by name. No stage list is hardcoded here: a
 * workflow with other stages gets their lanes. Empty stages show only once the server reports a
 * workflow's stage list (needs a read: spec 41, slice 2).
 */
export function boardLanes(items: ActiveItem[], labels: Record<string, string>): Lane[] {
  const known = Object.keys(labels);
  const rank = (stage: string) => {
    const i = known.indexOf(stage);
    return i < 0 ? known.length : i;
  };
  const queued = items.filter((i) => i.status === "queued");
  const byStage = new Map<string, ActiveItem[]>();
  for (const i of items) {
    if (i.status === "queued") continue;
    byStage.set(i.stage, [...(byStage.get(i.stage) ?? []), i]);
  }
  const phaseOf = (stage: string): "shaping" | "delivery" =>
    byStage.get(stage)?.[0]?.phase === "shaping" ? "shaping" : "delivery";
  const stages = [...byStage.keys()].sort(
    (a, b) =>
      (phaseOf(a) === phaseOf(b) ? 0 : phaseOf(a) === "shaping" ? -1 : 1) ||
      rank(a) - rank(b) ||
      a.localeCompare(b),
  );
  return [
    { key: "queued", label: "Queued", phase: "queued", items: queued },
    ...stages.map((stage) => ({
      key: stage,
      label: labels[stage] ?? stage[0]?.toUpperCase() + stage.slice(1),
      phase: phaseOf(stage),
      items: byStage.get(stage) ?? [],
    })),
  ];
}

/** Who an item in the factory waits on, in the design's words, with its dot. */
export function waitingOn(
  item: Pick<BoardItem, "id" | "status" | "blockedBy">,
  needsYou: Set<string>,
): { label: string; status: "waiting" | "running" | "idle" } {
  if (needsYou.has(item.id)) return { label: "Waiting on you", status: "waiting" };
  if (item.status === "queued") {
    return item.blockedBy.length
      ? {
          label: `Waiting for ${item.blockedBy.map((b) => `#${b.number}`).join(", ")}`,
          status: "idle",
        }
      : { label: "Waiting for a slot", status: "idle" };
  }
  if (item.status === "running") return { label: "Agent working", status: "running" };
  if (item.status === "paused") return { label: "Paused", status: "idle" };
  return { label: "Waiting on someone else", status: "idle" };
}

/** The order the All projects list sorts by: you first, then agents, then the rest. */
export function waitingOrder(item: Pick<BoardItem, "id" | "status">, needsYou: Set<string>) {
  if (needsYou.has(item.id)) return 0;
  if (item.status === "running") return 1;
  if (item.status === "waiting") return 2;
  if (item.status === "paused") return 3;
  return 4;
}

/** A finished item's result, in words, with its dot (design WorkDone). */
export function outcomeOf(item: { status: string; statusReason: string | null }): {
  label: string;
  status: "done" | "failed" | "idle";
} {
  const reason = item.statusReason ? `: ${item.statusReason}` : "";
  if (item.status === "done") return { label: `Done${reason}`, status: "done" };
  if (item.status === "cancelled") return { label: `Cancelled${reason}`, status: "idle" };
  if (item.status === "rejected") return { label: `Rejected${reason}`, status: "failed" };
  return { label: `Failed${reason}`, status: "failed" };
}

/** A board card's chip: what the item is doing, and whether it needs you. */
export function cardState(
  item: { id: string; status: string },
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
