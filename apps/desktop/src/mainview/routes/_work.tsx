// The Work section (spec 41, design WorkActive; spec 50, WorkBacklog): its nested list (Backlog,
// Planning, Ready, In the factory, Done, then each project) beside the page. Counts are
// `workItem.board`'s, per project and state across each org.
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { FolderIcon, PlusIcon } from "lucide-react";
import { ListGroup, ListItem, NestedList } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import { boardsQuery, workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { openCount, VIEW_LABEL, viewCounts, type WorkView, workPlace } from "../lib/work-board.ts";
import { appRoute, useFocused } from "./_app.tsx";

export const workLayout = createRoute({
  getParentRoute: () => appRoute,
  id: "_work",
  // The list's counts come from the shell's work lists; this keeps them loaded with the page.
  loader: ({ context: { queryClient, session } }) => {
    const orgIds = session.orgs.map((o) => o.id);
    return Promise.all([
      queryClient.ensureQueryData(workListsQuery(orgIds)),
      queryClient.ensureQueryData(boardsQuery(orgIds)),
    ]).catch(() => null);
  },
  component: WorkSection,
});

function WorkSection() {
  const focused = useFocused();
  return (
    <>
      {!focused && <WorkNav />}
      <Outlet />
    </>
  );
}

function useWorkPlace() {
  const loc = useRouterState({ select: (s) => s.location });
  const session = useSession();
  const orgIds = session.orgs.map((o) => o.id);
  const items = useQuery(workListsQuery(orgIds));
  const board = useQuery(boardsQuery(orgIds));
  return workPlace(
    loc.pathname,
    loc.search as { view?: WorkView; project?: string },
    (id) =>
      board.data?.items.find((i) => i.id === id)?.projectId ??
      items.data?.find((i) => i.id === id)?.projectId ??
      null,
  );
}

function WorkNav() {
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const board = useQuery(boardsQuery(session.orgs.map((o) => o.id)));
  const place = useWorkPlace();
  const counts = viewCounts(board.data?.counts ?? [], { orgId });
  const scopedProjects = (projects.data ?? []).filter((p) => orgId === null || p.orgId === orgId);
  const perProject = (id: string) => (board.data ? openCount(board.data.counts, id) : null);
  // Planning shows only while something is being shaped.
  const views = (["backlog", "planning", "ready", "active", "done"] as WorkView[]).filter(
    (v) => v !== "planning" || counts[v] > 0,
  );
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
          count={board.data ? counts[v] : null}
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
