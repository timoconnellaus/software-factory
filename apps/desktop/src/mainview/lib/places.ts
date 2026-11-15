// The places in the app (spec 41, spec 70): what a tab is called, and the search palette's places.
// Pure, so the tests pin them.

/** A tab's title: the section a path is in, a project's board, an item, or All orgs. */
export function tabTitle(path: string, findProject: (id: string) => string | null = () => null) {
  const pathname = path.split("?")[0] ?? "/";
  const flow = /^\/flow(?:\/[^/]+\/([^/]+)(?:\/([^/]+))?(\/i\/)?)?/.exec(pathname);
  if (!flow) return "Software Factory";
  if (pathname === "/flow/orgs") return "All orgs";
  if (flow[3]) return "Item";
  if (flow[1] === "p") {
    if (path.includes("item=")) return "Item";
    return (flow[2] && findProject(flow[2])) || "Board";
  }
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
