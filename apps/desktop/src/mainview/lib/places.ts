// The places in the app (spec 41, spec 70): what a tab is called, and the search palette's places.
// Pure, so the tests pin them.

/** What a tab can name, from what the app has already read; null when it hasn't. */
export interface TabNames {
  project?: (id: string) => string | null;
  /** "SF-2 Record the milestone": the item's key and title. */
  item?: (id: string) => string | null;
  chat?: (id: string) => string | null;
  /** "Builder · SF-2 Record the milestone": the run's agent and its item. */
  run?: (id: string) => string | null;
}

/**
 * A tab's title: what it shows. A run, an item, a chat or a project by its name once read (else
 * Run, Item, Chat, Board), a section by its name, or All orgs.
 */
export function tabTitle(path: string, names: TabNames = {}) {
  const [pathname = "/", query = ""] = path.split("?");
  const search = new URLSearchParams(query);
  const flow = /^\/flow(?:\/[^/]+\/([^/]+)(?:\/([^/]+))?(?:\/i\/([^/]+))?)?/.exec(pathname);
  if (!flow) return "Software Factory";
  if (pathname === "/flow/orgs") return "All orgs";
  const run = search.get("run");
  if (run) return names.run?.(run) || "Run";
  const item = flow[3] ?? search.get("item");
  if (item) return names.item?.(item) || "Item";
  const chat = search.get("chat");
  if (flow[1] === "chat" && chat) return names.chat?.(chat) || "Chat";
  if (flow[1] === "p") return (flow[2] && names.project?.(flow[2])) || "Board";
  const part = flow[1] ?? "work";
  return part.charAt(0).toUpperCase() + part.slice(1);
}

export interface Place {
  id: string;
  label: string;
  /** A path in the app. */
  to: string;
  keywords: string;
}

/** The places the palette can go to in one org: its sections, then its projects. */
export function placesIn(orgId: string, projects: { id: string; name: string }[]): Place[] {
  const at = (part: string) => `/flow/${orgId}/${part}`;
  return [
    { id: "inbox", label: "Inbox", to: at("inbox"), keywords: "inbox waiting decisions" },
    { id: "work", label: "Work", to: at("work"), keywords: "work board items" },
    { id: "chat", label: "Chat", to: at("chat"), keywords: "chat" },
    { id: "team", label: "Team", to: at("team"), keywords: "team agents runners people" },
    { id: "auto", label: "Auto", to: at("auto"), keywords: "auto schedules" },
    { id: "plugins", label: "Plugins", to: at("plugins"), keywords: "plugins gateways" },
    {
      id: "settings",
      label: "Settings",
      to: at("settings"),
      keywords: "settings this mac runner sign out update members",
    },
    { id: "orgs", label: "All orgs", to: "/flow/orgs", keywords: "all orgs everything" },
    ...projects.map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      to: at(`p/${p.id}`),
      keywords: `project ${p.name.toLowerCase()}`,
    })),
  ];
}

/** The places matching what was typed: every word in the label or the keywords. */
export function matchPlaces(places: Place[], query: string): Place[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return places.filter((p) => {
    const hay = `${p.label.toLowerCase()} ${p.keywords}`;
    return words.every((w) => hay.includes(w));
  });
}
