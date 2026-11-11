// The signed-in shell (mockups: home-inbox, org-switcher for the shell only): a sidebar with the
// org, + New work, Platform links, the projects and the runner health line, and a header with the
// page's breadcrumb.
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@software-factory/ui/components/sidebar";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "#/components/app-sidebar";
import { inboxQuery, projectsQuery, sessionQuery } from "#/lib/queries";

export const Route = createFileRoute("/_app")({
  // The session comes from the query cache: fetched once per page load, then client navigations
  // don't wait on it. Once stale it is re-checked in the background (and AppLayout signs out if
  // it has gone). Every operation still checks the session itself.
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData({
      ...sessionQuery(),
      revalidateIfStale: true,
    });
    if (!session) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    return { session };
  },
  // What the shell renders on every page: the sidebar's projects and inbox count. Child loaders
  // run alongside this one, and their reads go out in the same request.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(projectsQuery(context.session.orgs.map((o) => o.id))),
      context.queryClient.ensureQueryData(inboxQuery()),
    ]).catch(() => null),
  component: AppLayout,
});

function AppLayout() {
  useSignOutWhenSessionEnds();
  return (
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
  );
}

/** A background session check that finds no session sends the person to sign in. */
function useSignOutWhenSessionEnds() {
  const session = useQuery(sessionQuery());
  const ended = session.isSuccess && session.data === null;
  useEffect(() => {
    if (ended) {
      window.location.assign(`/sign-in?redirect=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [ended]);
}

function Breadcrumb() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const crumbs: [string, string] =
    path === "/"
      ? ["Factory", "Inbox"]
      : path === "/new"
        ? ["Work", "New work"]
        : path === "/setup"
          ? ["Factory", "Setup"]
          : path === "/runners/connect"
            ? ["Factory", "Connect a runner"]
            : path === "/work"
              ? ["Factory", "Work"]
              : path.endsWith("/review")
                ? ["Work", "Review packet"]
                : ["Factory", "Work item"];
  return (
    <span className="text-muted-foreground text-sm" data-testid="breadcrumb">
      {crumbs[0]} / <b className="font-medium text-foreground">{crumbs[1]}</b>
    </span>
  );
}
