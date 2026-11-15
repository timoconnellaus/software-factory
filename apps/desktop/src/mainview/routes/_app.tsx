// The signed-in window (spec 41, spec 70): the toolbar (tabs, ⌘K) above the new core's shell
// (components/flow/shell.tsx): the org strip, the sidebar and the content panel. `beforeLoad` puts
// who is signed in (`org.list`) in the route context, for every page under it.
import { OpError } from "@software-factory/client/ops";
import { TooltipProvider } from "@software-factory/ui/components/tooltip";
import { createRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { bun } from "../bridge.ts";
import { FlowShell } from "../components/flow/shell.tsx";
import { CommandPalette } from "../components/shell-palette.tsx";
import { Toolbar, useTabs } from "../components/shell-toolbar.tsx";
import { WindowSkeleton } from "../components/window-skeleton.tsx";
import { meQuery } from "../lib/queries.ts";
import { isTypingTarget, matchShortcut, type ShortcutAction } from "../lib/shortcuts.ts";
import { getViewState } from "../lib/view-state.ts";
import { rootRoute } from "./root.tsx";

export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: async ({ context }) => {
    const desktop = await bun.session({});
    // Signed out is a state (the root shows sign-in), so the door isn't asked for anything.
    if (!desktop.signedIn) throw new OpError("unauthenticated", "signed out");
    const session = await context.queryClient.ensureQueryData({
      ...meQuery(desktop.login),
      revalidateIfStale: true,
    });
    return { session };
  },
  component: AppLayout,
  // Loading the shell itself (the session and its first reads): the whole window, not a page.
  pendingComponent: WindowSkeleton,
});

function AppLayout() {
  const [search, setSearch] = useState(false);
  useShortcuts(() => setSearch(true));
  return (
    <TooltipProvider>
      <div className="flex h-dvh select-none flex-col bg-window text-ink" data-testid="window">
        <Toolbar onSearch={() => setSearch(true)} />
        <FlowShell />
        <CommandPalette open={search} onOpenChange={setSearch} />
      </div>
    </TooltipProvider>
  );
}

/** The window's shortcuts (lib/shortcuts.ts has the table). */
function useShortcuts(openSearch: () => void) {
  const router = useRouter();
  const tabs = useTabs();
  useEffect(() => {
    function run(action: ShortcutAction) {
      switch (action) {
        case "search":
          return openSearch();
        case "back":
          return router.history.back();
        case "forward":
          return router.history.forward();
        case "new-tab":
          return tabs.newTab();
        case "close-tab":
          return tabs.close(getViewState().activeTab);
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
  }, [router, tabs, openSearch]);
}
