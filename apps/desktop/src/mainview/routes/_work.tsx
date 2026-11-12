// The Work section (spec 41, design WorkActive): its nested list (In the factory, Done, Stopped, then
// each project) beside the page. Backlog, Ready and saved views come with spec 50 (slice 2).
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { FolderIcon, PlusIcon } from "lucide-react";
import { ListGroup, ListItem, NestedList } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import { workItemQuery, workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { countsByView, VIEW_LABEL, type WorkView } from "../lib/work-board.ts";
import { appRoute } from "./_app.tsx";

export const workLayout = createRoute({
  getParentRoute: () => appRoute,
  id: "_work",
  // The list's counts come from the shell's work lists; this keeps them loaded with the page.
  loader: ({ context: { queryClient, session } }) =>
    queryClient
      .ensureQueryData(workListsQuery(session.orgs.map((o) => o.id)))
      .catch(() => null),
  component: WorkSection,
});

function WorkSection() {
  return (
    <>
      <WorkNav />
      <Outlet />
    </>
  );
}

/** Where the Work list is: the view and project from `/work`'s search, or the open item's project. */
function useWorkPlace(): { view: WorkView | null; projectId: string | null } {
  const loc = useRouterState({ select: (s) => s.location });
  const itemId = /^\/work\/([^/]+)/.exec(loc.pathname)?.[1];
  const item = useQuery({
    ...workItemQuery(itemId ?? ""),
    enabled: !!itemId,
    refetchInterval: false,
  });
  if (loc.pathname === "/work") {
    const s = loc.search as { view?: WorkView; project?: string };
    return { view: s.project ? null : (s.view ?? "active"), projectId: s.project ?? null };
  }
  if (itemId) return { view: null, projectId: item.data?.item.projectId ?? null };
  return { view: null, projectId: null };
}

function WorkNav() {
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const items = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const place = useWorkPlace();
  const counts = countsByView(items.data ?? [], orgId);
  const scopedProjects = (projects.data ?? []).filter((p) => orgId === null || p.orgId === orgId);
  const perProject = (id: string) => (items.data ?? []).filter((i) => i.projectId === id).length;
  const views: WorkView[] = counts.stopped > 0 ? ["active", "done", "stopped"] : ["active", "done"];
  return (
    <NestedList
      title="Work"
      action={
        <Link
          to="/new"
          aria-label="New work item"
          title="New work item (⌘N)"
          className="flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-selected"
        >
          <PlusIcon className="size-4" />
        </Link>
      }
    >
      <ListGroup>All projects</ListGroup>
      {views.map((v) => (
        <ListItem
          key={v}
          to="/work"
          search={{ view: v }}
          active={place.view === v}
          count={counts[v]}
          data-testid={`work-view-${v}`}
        >
          {VIEW_LABEL[v]}
        </ListItem>
      ))}
      <ListGroup>Projects</ListGroup>
      {scopedProjects.map((p) => (
        <ListItem
          key={p.id}
          to="/work"
          search={{ project: p.id }}
          active={place.projectId === p.id}
          icon={<FolderIcon />}
          count={perProject(p.id)}
          data-testid={`work-project-${p.slug}`}
        >
          {p.name}
        </ListItem>
      ))}
      {projects.data && scopedProjects.length === 0 && (
        <p className="px-2 py-1 text-ink-muted text-xs">
          No projects yet.{" "}
          <Link to="/setup" className="underline">
            Add one in Setup
          </Link>
        </p>
      )}
    </NestedList>
  );
}
