// The places in the app (spec 41): what a tab is called, which sidebar section a path is in, and
// the search palette's commands. Pure, so the tests pin them.

export type Section = "inbox" | "work" | "factory" | "settings";

export function sectionOf(pathname: string): Section {
  if (pathname === "/" || pathname === "") return "inbox";
  if (pathname === "/setup" || pathname === "/settings") return "settings";
  if (pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/factory" || pathname.startsWith("/factory/")) return "factory";
  return "work";
}

export interface ItemRef {
  number: number;
  title: string;
  status: string;
}

/**
 * A tab's title. A work item is "#12 Its title" once the app has it loaded, else "Work item"; a
 * project's page is the project's name once loaded, else "Project".
 */
export function tabTitle(
  path: string,
  findItem: (id: string) => ItemRef | null,
  findProject: (id: string) => string | null = () => null,
): string {
  const pathname = path.split("?")[0] ?? "/";
  const item = /^\/work\/([^/]+)(\/review)?$/.exec(pathname);
  if (item?.[1]) {
    const ref = findItem(decodeURIComponent(item[1]));
    return ref ? `#${ref.number} ${ref.title}` : "Work item";
  }
  switch (pathname) {
    case "/":
      return "Inbox";
    case "/work": {
      const q = new URLSearchParams(path.split("?")[1] ?? "");
      const view = q.get("view");
      const project = q.get("project");
      // A project's board is the project's, as its header says.
      if (project && view === "active") return findProject(project) ?? "Project";
      if (view && view in WORK_VIEW_TITLE) return WORK_VIEW_TITLE[view] as string;
      return project ? (findProject(project) ?? "Project") : "In the factory";
    }
    case "/new":
      return "New item";
    case "/attach":
      return "Attach a pull request";
    case "/setup":
      return "Setup";
    case "/settings":
      return "This Mac";
    case "/settings/repositories":
      return "Repositories";
    case "/settings/connections":
      return "Connections";
    case "/settings/devices":
      return "Devices";
    case "/factory":
      return "Overview";
    case "/factory/runners":
      return "Runners";
    case "/factory/incidents":
      return "Checks and incidents";
    case "/factory/policy":
      return "Policy";
    case "/factory/agents":
      return "Agents";
    case "/factory/workflows":
      return "Workflows";
    default:
      return "Software Factory";
  }
}

/** The Work section's views as tab titles (lib/work-board.ts's VIEW_LABEL). */
const WORK_VIEW_TITLE: Record<string, string> = {
  backlog: "Backlog",
  planning: "Planning",
  ready: "Ready",
  active: "In the factory",
  done: "Done",
};

export interface PlaceCommand {
  id: string;
  label: string;
  to: string;
  search?: Record<string, string>;
  keywords: string;
}

/** The places the palette can go to, besides work items. Only screens that exist. */
export const PLACE_COMMANDS: PlaceCommand[] = [
  { id: "inbox", label: "Inbox", to: "/", keywords: "inbox gates waiting decisions" },
  { id: "new", label: "New item", to: "/new", keywords: "new work item create send" },
  {
    id: "backlog",
    label: "Work: backlog",
    to: "/work",
    search: { view: "backlog" },
    keywords: "work backlog captured later ideas",
  },
  {
    id: "ready",
    label: "Work: ready",
    to: "/work",
    search: { view: "ready" },
    keywords: "work ready release shaped",
  },
  { id: "work", label: "Work: in the factory", to: "/work", keywords: "work running active" },
  {
    id: "done",
    label: "Work: done",
    to: "/work",
    search: { view: "done" },
    keywords: "work done shipped finished",
  },
  { id: "setup", label: "Setup", to: "/setup", keywords: "setup github project runner protect" },
  { id: "mac", label: "This Mac", to: "/settings", keywords: "this mac runner settings sign out" },
  {
    id: "repositories",
    label: "Repositories",
    to: "/settings/repositories",
    keywords: "settings repositories repos github protection",
  },
  {
    id: "connections",
    label: "Connections",
    to: "/settings/connections",
    keywords: "settings connections github app",
  },
  {
    id: "devices",
    label: "Devices",
    to: "/settings/devices",
    keywords: "settings devices tokens cli revoke sign in",
  },
  { id: "factory", label: "Factory: overview", to: "/factory", keywords: "factory overview queue" },
  {
    id: "runners",
    label: "Factory: runners",
    to: "/factory/runners",
    keywords: "factory runners machines version update",
  },
  {
    id: "incidents",
    label: "Factory: checks and incidents",
    to: "/factory/incidents",
    keywords: "factory incidents checks failures",
  },
  {
    id: "policy",
    label: "Factory: policy",
    to: "/factory/policy",
    keywords: "factory policy autonomy limits approvers",
  },
  {
    id: "agents",
    label: "Factory: agents",
    to: "/factory/agents",
    keywords: "factory agents roles models",
  },
  {
    id: "workflows",
    label: "Factory: workflows",
    to: "/factory/workflows",
    keywords: "factory workflows stages steps",
  },
];

/** Work items matching a search: by number (`12`, `#12`) or by words in the title. */
export function matchItems<T extends { number: number; title: string }>(
  items: T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const num = /^#?(\d+)$/.exec(q)?.[1];
  if (num) {
    const n = Number(num);
    const exact = items.filter((i) => i.number === n);
    const prefix = items.filter((i) => i.number !== n && String(i.number).startsWith(num));
    return [...exact, ...prefix].slice(0, limit);
  }
  const words = q.split(/\s+/);
  return items
    .filter((i) => {
      const t = i.title.toLowerCase();
      return words.every((w) => t.includes(w));
    })
    .slice(0, limit);
}

/**
 * Where a work item opens from a card or a list row: its page today. Spec 41's item side panel (a
 * later slice, design WorkActivePanel) opens a running item in a panel over the board instead, so
 * every card and row opens through this, and that slice changes it here.
 */
export function openItem(id: string) {
  return { to: "/work/$id", params: { id } } as const;
}
