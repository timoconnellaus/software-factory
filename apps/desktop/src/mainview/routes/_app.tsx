// The signed-in window (spec 41, ADR 0460): the toolbar, the org rail, the sidebar, the white
// content panel (each section puts its nested list and page in it) and the status bar. Only the
// list and the page scroll. `beforeLoad` puts who is signed in (`org.list`) in the route context,
// for every page under it.
import { TooltipProvider } from "@software-factory/ui/components/tooltip";
import {
  createRoute,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { bun } from "../bridge.ts";
import { FocusBar } from "../components/focus-bar.tsx";
import { CommandPalette } from "../components/shell-palette.tsx";
import { OrgRail, Sidebar } from "../components/shell-sidebar.tsx";
import { StatusBar } from "../components/shell-status-bar.tsx";
import { Toolbar, useTabs } from "../components/shell-toolbar.tsx";
import { inboxQuery, meQuery, projectsQuery, workListsQuery } from "../lib/queries.ts";
import { isTypingTarget, matchShortcut, type ShortcutAction } from "../lib/shortcuts.ts";
import {
  getViewState,
  setFocus,
  toggleSidebar,
  updateViewState,
  useViewState,
} from "../lib/view-state.ts";
import { rootRoute } from "./root.tsx";

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: async ({ context }) => {
    const desktop = await bun.session({});
    const session = await context.queryClient.ensureQueryData({
      ...meQuery(desktop.login),
      revalidateIfStale: true,
    });
    return { session };
  },
  // What the shell renders on every page: the projects, the inbox (the counts, the rail's dots,
  // the status bar) and each org's recent work items (pins, tabs, search). Child loaders run
  // alongside this one, and their reads go out in the same batch.
  loader: ({ context }) => {
    const orgIds = context.session.orgs.map((o) => o.id);
    return Promise.all([
      context.queryClient.ensureQueryData(projectsQuery(orgIds)),
      context.queryClient.ensureQueryData(inboxQuery()),
      context.queryClient.ensureQueryData(workListsQuery(orgIds)),
    ]).catch(() => null);
  },
  component: AppLayout,
});

/** The work item in focus mode, when the window is on it (spec 41). Leaving the item leaves focus. */
export function useFocused(): string | null {
  const focus = useViewState((s) => s.focus);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const here = focus !== null && pathname === `/work/${focus}`;
  // Focus asked for in the Work list's side panel: the panel expands to the page, then focuses.
  const inPanel = useRouterState({
    select: (s) => s.location.pathname === "/work" && (s.location.search as { item?: string }).item,
  });
  useEffect(() => {
    if (focus !== null && !here && inPanel !== focus) updateViewState((s) => setFocus(s, null));
  }, [focus, here, inPanel]);
  return here ? focus : null;
}

function AppLayout() {
  const sidebar = useViewState((s) => s.sidebar);
  const focused = useFocused();
  const [search, setSearch] = useState(false);
  useShortcuts(() => setSearch(true));
  return (
    <TooltipProvider>
      <div className="flex h-dvh select-none flex-col bg-window text-ink" data-testid="window">
        {focused ? <FocusBar workItemId={focused} /> : <Toolbar onSearch={() => setSearch(true)} />}
        <div className={focused ? "flex min-h-0 flex-1 px-2" : "flex min-h-0 flex-1 pr-2"}>
          {!focused && <OrgRail />}
          {!focused && sidebar && <Sidebar />}
          <div
            className="flex min-w-0 flex-1 select-text overflow-hidden rounded-xl bg-panel shadow-panel"
            data-testid="content-panel"
          >
            <Outlet />
          </div>
        </div>
        <StatusBar />
        <CommandPalette open={search} onOpenChange={setSearch} />
      </div>
    </TooltipProvider>
  );
}

/** The window's shortcuts (lib/shortcuts.ts has the table). */
function useShortcuts(openSearch: () => void) {
  const router = useRouter();
  const navigate = useNavigate();
  const tabs = useTabs();
  useEffect(() => {
    function run(action: ShortcutAction) {
      switch (action) {
        case "search":
          return openSearch();
        case "new-item":
          return void navigate({ to: "/new" });
        case "inbox":
          return void navigate({ to: "/" });
        case "work":
          return void navigate({ to: "/work" });
        case "settings":
          return void navigate({ to: "/settings" });
        case "back":
          return router.history.back();
        case "forward":
          return router.history.forward();
        case "sidebar":
          return updateViewState(toggleSidebar);
        case "new-tab":
          return tabs.newTab();
        case "close-tab":
          return tabs.close(getViewState().activeTab);
        case "list-next":
        case "list-prev":
          return moveInList(action === "list-next" ? 1 : -1);
      }
    }
    function onKey(e: KeyboardEvent) {
      // A dialog (the palette, a note) handles its own keys.
      if (document.querySelector("[role=dialog]")) return;
      const action = matchShortcut(e, isTypingTarget(e.target as Element | null));
      if (!action) return;
      e.preventDefault();
      run(action);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, navigate, tabs, openSearch]);
}

/** ↑ and ↓ move the nested list's selection: the next row's link is followed. */
function moveInList(step: 1 | -1) {
  const rows = [
    ...document.querySelectorAll<HTMLAnchorElement>("[data-nested-list] a[data-list-item]"),
  ];
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r.getAttribute("aria-current") === "true");
  const next = rows[at < 0 ? 0 : Math.min(Math.max(at + step, 0), rows.length - 1)];
  next?.click();
  next?.scrollIntoView({ block: "nearest" });
}
