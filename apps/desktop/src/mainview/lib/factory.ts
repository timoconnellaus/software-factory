// The Factory section's wording and joins (spec 41, slice 5): what is running, the queue, each
// runner's state, version and load, and the incidents. Everything comes from operations the client
// door already serves (`inbox.list`, `runner.list`, `workItem.list`, `mergeQueue.list`). Pure, so the
// tests pin it.
import type { Inbox, OpOutput } from "@software-factory/client/ops";
import { RUNNER_DOT } from "@software-factory/client/runners";
import type { Status } from "@software-factory/ui/components/status-dot";

type Item = OpOutput<"workItem.list">["items"][number];
type HealthRunner = Inbox["runners"][number];
type ListedRunner = OpOutput<"runner.list">["runners"][number];

const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];
const rank = (p: Item["priority"]) => {
  const i = PRIORITY_ORDER.indexOf(p ?? "normal");
  return i < 0 ? 2 : i;
};

/** Released work waiting for a free slot (ADR 0491), in the order it is pulled: the queue. */
export const queued = (items: Item[]) =>
  items
    .filter((i) => i.status === "queued")
    .sort(
      (a, b) =>
        rank(a.priority) - rank(b.priority) ||
        Date.parse(a.releasedAt ?? a.createdAt) - Date.parse(b.releasedAt ?? b.createdAt),
    );

/** Items with a run going now. */
export const runningNow = (items: Item[]) =>
  items
    .filter((i) => i.status === "running")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

export interface RunnerRow {
  id: string;
  name: string;
  state: HealthRunner["state"] | "unknown";
  dot: Status;
  /** "Online", "Offline", "Paused: load 19.3 on 10 cores", "Draining". An offline runner's time is
   * `lastSeenAt`, which the page shows relative, with the full date on hover. */
  stateText: string;
  heavy: string;
  light: string | null;
  /** The commit it runs, short; null when it hasn't reported one. */
  version: string | null;
  /** "up to date", "updating to 5da8988", "can't update: local changes", "rolled back: …". */
  versionText: string;
  /** True while an update waits or failed: the row's version reads as needing attention. */
  updatePending: boolean;
  updateNeedsYou: boolean;
  autoUpdate: boolean | null;
  harnesses: string[];
  kind: string | null;
  /** Where the project's checks run on it, or why not, in one line (doctor's); null: not reported. */
  checks: string | null;
  rateLimitedUntil: string | null;
  lastSeenAt: string | null;
  accounts: ListedRunner["accounts"];
  /** Whose runner it is: only its owner switches its accounts. */
  ownerUserId: string;
}

const HARNESS_LABEL: Record<string, string> = { "claude-code": "Claude Code" };

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null);

/**
 * One row per runner: the health line's state and slots (`inbox.list`) joined with what the runner
 * reported about itself (`runner.list`: version, the update, harness, accounts).
 */
export function runnerRows(
  health: HealthRunner[],
  listed: ListedRunner[],
  clock: (iso: string) => string,
): RunnerRow[] {
  const byId = new Map(health.map((h) => [h.id, h]));
  return listed.map((r) => {
    const h = byId.get(r.id);
    const state = h?.state ?? "unknown";
    const up = h && h.state !== "offline";
    const heavyUse = up ? h.inUse : 0;
    const heavyMax = h?.max ?? r.capacityMax;
    const light = h?.light ?? r.light;
    const update = r.update;
    const desired = r.desiredVersion;
    let versionText = "up to date";
    let updatePending = false;
    let updateNeedsYou = false;
    if (!r.version) versionText = "no version reported";
    else if (update?.state === "blocked") {
      versionText = update.reason ? `can't update: ${update.reason}` : "can't update";
      updatePending = updateNeedsYou = true;
    } else if (update?.state === "rolled_back") {
      versionText = update.reason ? `update rolled back: ${update.reason}` : "update rolled back";
      updatePending = updateNeedsYou = true;
    } else if (update?.state === "updating") {
      versionText = `updating to ${short(update.target ?? desired)}`;
      updatePending = true;
    } else if (
      update?.state === "waiting" ||
      (update?.state !== "current" && desired && r.version !== desired)
    ) {
      versionText = `update to ${short(update?.target ?? desired)} waits until it's idle`;
      updatePending = true;
    }
    return {
      id: r.id,
      name: r.name,
      state,
      dot: h ? RUNNER_DOT[h.state] : "idle",
      stateText: stateText(h, clock),
      heavy: `${heavyUse} of ${heavyMax}`,
      light: light ? `${up ? light.inUse : 0} of ${light.max}` : null,
      version: short(r.version),
      versionText,
      updatePending,
      updateNeedsYou,
      autoUpdate: r.autoUpdate,
      harnesses: (r.manifest?.harnesses ?? []).map((h) => HARNESS_LABEL[h] ?? h),
      kind: r.manifest?.runnerKind ?? null,
      checks: r.manifest?.checksNote ?? null,
      rateLimitedUntil: r.rateLimitedUntil,
      lastSeenAt: h?.lastSeenAt ?? r.lastSeenAt,
      accounts: r.accounts,
      ownerUserId: r.ownerUserId,
    };
  });
}

function stateText(h: HealthRunner | undefined, clock: (iso: string) => string): string {
  if (!h) return "Not reported";
  switch (h.state) {
    case "offline":
      return h.lastSeenAt ? "Offline" : "Never seen";
    case "rate-limited":
      return h.rateLimitedUntil
        ? `Rate-limited until ${clock(h.rateLimitedUntil)}`
        : "Rate-limited";
    case "draining":
      return "Draining";
  }
  const p = h.paused && h.paused.reason !== "draining" ? h.paused : null;
  if (p) {
    const why =
      p.reason === "load"
        ? `load ${p.load1 !== undefined ? p.load1.toFixed(1) : "high"}${p.cores ? ` on ${p.cores} cores` : ""}`
        : "tmux not answering";
    return `Paused: ${why}`;
  }
  return h.state === "busy" ? "Busy" : "Online";
}

/** The runners' totals for the overview: online out of all. */
export function runnersOnline(health: HealthRunner[]): { online: number; total: number } {
  return {
    online: health.filter((r) => r.state !== "offline").length,
    total: health.length,
  };
}

/** Statuses after which an incident is closed. A fix that failed leaves it open. */
const CLOSED = new Set<Item["status"]>(["done", "rejected", "cancelled"]);

export interface IncidentRow {
  id: string;
  number: number;
  projectId: string;
  /** The fix item's own title, as the factory wrote it. What went wrong and the item it came from
   * aren't in `workItem.list` (they are `core_incidents.kind` and `source_work_item_id`): the page
   * shows the title as it is rather than guessing them from its wording. */
  title: string;
  open: boolean;
  status: Item["status"];
  stage: Item["stage"];
  statusReason: string | null;
  prUrl: string | null;
  openedAt: string;
  updatedAt: string;
}

/**
 * The incidents, from the work items the factory opened for them (`kind: "incident"`): an incident
 * is open until its fix item is done, rejected or cancelled. Newest first.
 */
export function incidentRows(items: Item[]): IncidentRow[] {
  return items
    .filter((i) => i.kind === "incident")
    .map((i) => ({
      id: i.id,
      number: i.number,
      projectId: i.projectId,
      title: i.title,
      open: !CLOSED.has(i.status),
      status: i.status,
      stage: i.stage,
      statusReason: i.statusReason,
      prUrl: i.prUrl,
      openedAt: i.createdAt,
      updatedAt: i.updatedAt,
    }))
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
}

/** Where an incident's fix stands, in a few words: "In build", "Waiting on you", "Merged". */
export function fixText(r: Pick<IncidentRow, "status" | "stage" | "statusReason">): string {
  switch (r.status) {
    case "done":
      return "Fixed";
    case "rejected":
      return "Rejected";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    case "waiting":
      return r.statusReason ? `Waiting: ${r.statusReason}` : "Waiting on you";
    case "queued":
      return "Queued";
    case "paused":
      return "Paused";
    case "backlog":
    case "shaping":
    case "ready":
      return "Not started";
    default:
      return `In ${r.stage}`;
  }
}
