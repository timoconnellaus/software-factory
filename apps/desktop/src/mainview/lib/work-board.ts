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
  /** `queued`, or the stage's name as the workflow read reports it. */
  key: string;
  label: string;
  items: ActiveItem[];
}

/** A workflow's stage as `project.workflow` reports it, in order. */
export interface StageInfo {
  stage: string;
  label: string;
}

/**
 * A project's board lanes (spec 50): Queued first (released, not yet pulled: the lane every
 * workflow has), then every stage of the project's workflow in the order the server reports them,
 * empty ones included so the columns don't move as items do. Lanes are labelled from the read,
 * never from a stage name. An item in a stage the read doesn't list (intake, the engine's entry,
 * for the moment after the pull) shows in the first stage's lane.
 */
export function boardLanes(items: ActiveItem[], stages: StageInfo[]): Lane[] {
  const lanes: Lane[] = [
    { key: "queued", label: "Queued", items: items.filter((i) => i.status === "queued") },
    ...stages.map((s) => ({ key: s.stage, label: s.label, items: [] as ActiveItem[] })),
  ];
  for (const i of items) {
    if (i.status === "queued") continue;
    const lane = lanes.find((l) => l.key === i.stage) ?? lanes[1];
    lane?.items.push(i);
  }
  return lanes;
}

/** An item's lane on its project's board, in words: "Queued", or its stage's label from the read. */
export function laneLabel(item: { status: string; stage: string }, stages: StageInfo[]): string {
  if (item.status === "queued") return "Queued";
  return (stages.find((s) => s.stage === item.stage) ?? stages[0])?.label ?? "";
}

/**
 * The All projects board's columns (the owner's decision, 2026-11-12): by phase, with release
 * between them. Before release (the server's phase `shaping`): Backlog, Shaping, Ready; from
 * release on (`delivery`): Queued, Delivery; then Done. Never from a stage name, so every
 * workflow's items sit in the same six columns.
 */
export const PHASE_COLUMNS = [
  { key: "backlog", label: "Backlog", view: "backlog" },
  { key: "shaping", label: "Shaping", view: "planning" },
  { key: "ready", label: "Ready", view: "ready" },
  { key: "queued", label: "Queued", view: "active" },
  { key: "delivery", label: "Delivery", view: "active" },
  { key: "done", label: "Done", view: "done" },
] as const satisfies readonly { key: string; label: string; view: WorkView }[];
export type PhaseColumn = (typeof PHASE_COLUMNS)[number]["key"];

/** Which phase column an item is in, from its phase (the server's) and its state. */
export function phaseColumn(item: { status: string; phase?: string }): PhaseColumn {
  if (FINISHED.includes(item.status)) return "done";
  if (item.phase === "shaping" || ["backlog", "shaping", "ready"].includes(item.status)) {
    return item.status === "ready" ? "ready" : item.status === "shaping" ? "shaping" : "backlog";
  }
  return item.status === "queued" ? "queued" : "delivery";
}

/** How an item ended: the statuses Done shows. */
export const FINISHED = ["done", "failed", "rejected", "cancelled"];

/**
 * When `workItem.board` cut its list (at most 500 items): how many the asked-for states hold by
 * its counts, against how many it returned. Null when nothing was cut.
 */
export function cutList(
  counts: { status: string; projectId: string; orgId: string; n: number }[],
  shown: number,
  opts: { states: readonly string[]; orgId: string | null; projectId?: string | null },
): { shown: number; of: number } | null {
  const of = counts
    .filter(
      (c) =>
        opts.states.includes(c.status) &&
        (opts.orgId === null || c.orgId === opts.orgId) &&
        (!opts.projectId || c.projectId === opts.projectId),
    )
    .reduce((n, c) => n + c.n, 0);
  return of > shown ? { shown, of } : null;
}

/** Who an item in the factory waits on, in the design's words, with its dot. */
export function waitingOn(
  item: Pick<BoardItem, "id" | "status" | "blockedBy"> & { waitingOn?: BoardItem["waitingOn"] },
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
  // Only when a runner has claimed a job for it (the board's waitingOn): otherwise it is between
  // steps or waiting on something the stage line names.
  if (item.waitingOn?.kind === "agent") return { label: "Agent working", status: "running" };
  if (item.status === "running") return { label: "In progress", status: "running" };
  if (item.status === "paused") return { label: "Paused", status: "idle" };
  return { label: "Waiting on someone else", status: "idle" };
}

/** The order the All projects list sorts by: you first, then agents, then the rest. */
export function waitingOrder(
  item: Pick<BoardItem, "id" | "status"> & { waitingOn?: BoardItem["waitingOn"] },
  needsYou: Set<string>,
) {
  if (needsYou.has(item.id)) return 0;
  if (item.waitingOn?.kind === "agent") return 1;
  if (item.status === "running") return 2;
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
