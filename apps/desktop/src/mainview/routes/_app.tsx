// The signed-in shell (ported from sf-app's `_app`, spec 40 M3): a sidebar with + New work, the
// Platform links, the projects and the runner health line, and a header with the page's breadcrumb.
// `beforeLoad` puts who is signed in (`org.list`) in the route context, for every page under it.
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@software-factory/ui/components/sidebar";
import { TooltipProvider } from "@software-factory/ui/components/tooltip";
import { createRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { bun } from "../bridge.ts";
import { AppSidebar } from "../components/app-sidebar.tsx";
import { inboxQuery, meQuery, projectsQuery } from "../lib/queries.ts";
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
  // What the shell renders on every page: the sidebar's projects and inbox count. Child loaders
  // run alongside this one, and their reads go out in the same batch.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectsQuery(context.session.orgs.map((o) => o.id))),
      context.queryClient.ensureQueryData(inboxQuery()),
    ]).catch(() => null),
  component: AppLayout,
});

function AppLayout() {
  return (
    <TooltipProvider>
      <SidebarProvider className="h-dvh overflow-hidden">
        <AppSidebar />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
            <SidebarTrigger className="md:hidden" aria-label="Toggle navigation" />
            <Breadcrumb />
          </header>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" id="main">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export function crumbsFor(path: string): [string, string] {
  if (path === "/") return ["Factory", "Inbox"];
  if (path === "/new") return ["Work", "New work"];
  if (path === "/setup") return ["Factory", "Setup"];
  if (path === "/settings") return ["Factory", "This Mac"];
  if (path === "/attach") return ["Work", "Attach a pull request"];
  if (path === "/work") return ["Factory", "Work"];
  if (path.endsWith("/review")) return ["Work", "Review packet"];
  return ["Factory", "Work item"];
}

function Breadcrumb() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsFor(path);
  return (
    <span className="text-muted-foreground text-sm" data-testid="breadcrumb">
      {crumbs[0]} / <b className="font-medium text-foreground">{crumbs[1]}</b>
    </span>
  );
}
