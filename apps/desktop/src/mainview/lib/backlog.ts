// Backlog and Ready (spec 50, design WorkBacklog/WorkReady/ItemBacklog): the rows each list shows,
// priorities as the design writes them, and why an item can't be released yet. Pure, so the tests
// pin them. The server decides every refusal again (`releaseRefusal` in core); these only say in
// advance what it would say, so a button isn't offered that can only fail.
import type { BoardItem, Project } from "@software-factory/client/ops";

/** A board item with the org its read came from (`workItem.board` is per org). */
export type BacklogItem = BoardItem & { orgId: string };

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The design's P-numbers: the stored priority (0 urgent … 3 low), so normal is P2. */
export const PRIORITY_SHORT: Record<Priority, string> = {
  urgent: "P0",
  high: "P1",
  normal: "P2",
  low: "P3",
};
export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "P0 · Urgent",
  high: "P1 · High",
  normal: "P2 · Normal",
  low: "P3 · Low",
};

/** The items of one state (or several), within the chosen org and project, in pull order. */
export function itemsIn(
  items: BacklogItem[],
  states: readonly string[],
  opts: { orgId: string | null; projectId?: string | null },
): BacklogItem[] {
  return items.filter(
    (i) =>
      states.includes(i.status) &&
      (opts.orgId === null || i.orgId === opts.orgId) &&
      (!opts.projectId || i.projectId === opts.projectId),
  );
}

/**
 * Why a person can't release this item now, or null. Mirrors core's `releaseRefusal` for what the
 * desktop can see: the project's config, and a repository when the item has none. What it waits
 * for doesn't stop a release: the item waits in Queued until those are done.
 */
export function releaseBlocker(
  item: Pick<BoardItem, "status" | "repositoryId"> & { heldForParent?: boolean | undefined },
  project: Pick<Project, "repositories" | "policy"> | undefined,
): string | null {
  if (item.status !== "backlog" && item.status !== "ready") return null;
  // Spec 24 (review of #173): split off a plan that hasn't merged, it starts with its siblings.
  if (item.heldForParent) return "Held until the plan merges: it starts with its siblings";
  if (!project) return "Its project isn't loaded";
  if (project.policy.state !== "valid") {
    return "The project's config isn't valid: fix it in Setup first";
  }
  if (!item.repositoryId) {
    return project.repositories.length === 0
      ? "Its project has no repository yet: add one in Setup"
      : "Choose which repository it changes";
  }
  return null;
}

/** What a released item will wait for in Queued, in words ("#23", "#23 and #24"), or null. */
export function waitsText(blockedBy: { number: number }[]): string | null {
  if (blockedBy.length === 0) return null;
  const ns = blockedBy.map((b) => `#${b.number}`);
  return ns.length === 1 ? (ns[0] ?? null) : `${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
}

/** Quick add: one item per non-empty line, trimmed, at most 50 (a title is at most 200). */
export function quickAddLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().slice(0, 200))
    .filter((l) => l.length > 0)
    .slice(0, 50);
}

/** The items a ready list can release in one go: those with nothing stopping their release. */
export function releasable(
  items: BacklogItem[],
  projectOf: (id: string) => Project | undefined,
): BacklogItem[] {
  return items.filter((i) => releaseBlocker(i, projectOf(i.projectId)) === null);
}

/** How long ago, short: "2 h", "3 d" (the lists' Age column). */
export function age(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/**
 * One refusal in a bulk report: the server's words with the item's number in front, unless they
 * already name it ("work item #20 needs a repository …").
 */
export function refusalText(number: number, reason: string): string {
  return reason.includes(`#${number}`) ? reason : `#${number}: ${reason}`;
}

/** A bulk action's one report: "Released 3 items. Not released: #20 …; #22 …". */
export function bulkReport(
  ok: number,
  refusals: string[],
  words: { done: (n: number) => string; not: string },
): string {
  const done = ok ? `${words.done(ok)}.` : "";
  const not = refusals.length ? `${words.not}: ${refusals.join("; ")}` : "";
  return [done, not].filter(Boolean).join(" ");
}

/** "title and priority", for a save's report. */
export function fieldNames(keys: string[]): string {
  const names = keys.map((k) =>
    k === "repositoryId" ? "repository" : k === "body" ? "description" : k,
  );
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
