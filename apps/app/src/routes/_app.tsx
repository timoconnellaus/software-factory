// The signed-in shell (mockups: home-inbox, org-switcher for the shell only): a sidebar with the
// org, + New work, Platform links, the projects and the runner health line, and a header with the
// page's breadcrumb.
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@software-factory/ui/components/sidebar";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { AppSidebar } from "#/components/app-sidebar";
import { projectsQuery } from "#/lib/queries";
import { getSession } from "#/server/fns";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const session = await getSession();
    if (!session) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    return { session };
  },
  loader: ({ context }) =>
    context.queryClient
      .ensureQueryData(projectsQuery(context.session.orgs.map((o) => o.id)))
      .catch(() => []),
  component: AppLayout,
});

function AppLayout() {
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
