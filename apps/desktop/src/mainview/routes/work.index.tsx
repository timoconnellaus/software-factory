// Work (spec 41, design WorkActive/WorkActiveAll/WorkDone; spec 50 adds WorkBacklog/WorkReady/
// WorkProject): one route for the section's views. `view` picks Backlog, Planning, Ready, In the
// factory or Done; `project` alone is the project's page, and with a view it filters that view. In
// the factory is, for one project, its board by stage (or a list), and across projects a list by
// who each item waits on.
import { createRoute, useNavigate } from "@tanstack/react-router";
import { ActiveAll, DoneList, type Layout, ProjectBoard } from "../components/work-active.tsx";
import { BacklogPage, PlanningPage, ReadyPage } from "../components/work-backlog.tsx";
import { ProjectPage } from "../components/work-project.tsx";
import { boardsQuery, configQuery, workListsQuery } from "../lib/queries.ts";
import type { WorkView } from "../lib/work-board.ts";
import { workLayout } from "./_work.tsx";
import { ItemPanel, loadItem, parseTab, type Tab } from "./work.$id.index.tsx";

interface Search {
  view?: WorkView;
  project?: string;
  layout?: Layout;
  /** The item open in the side panel, and its tab (spec 41 slice 7). */
  item?: string;
  itemTab?: Tab;
}

const VIEWS: WorkView[] = ["backlog", "planning", "ready", "active", "done"];

export const Route = createRoute({
  getParentRoute: () => workLayout,
  path: "/work",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(VIEWS.includes(s.view as WorkView) ? { view: s.view as WorkView } : {}),
    // Stopped was its own view before Done showed every outcome: old links land on Done.
    ...(s.view === "stopped" ? { view: "done" as const } : {}),
    ...(typeof s.project === "string" ? { project: s.project } : {}),
    ...(s.layout === "board" || s.layout === "list" ? { layout: s.layout } : {}),
    ...(typeof s.item === "string" ? { item: s.item } : {}),
    ...(parseTab(s.itemTab) ? { itemTab: parseTab(s.itemTab) } : {}),
  }),
  loaderDeps: ({ search }) => ({ project: search.project, view: search.view, item: search.item }),
  // The lists, a project's config (its workflow) on its page, and the item in the side panel.
  loader: ({ context: { queryClient, session }, deps }) => {
    const orgIds = session.orgs.map((o) => o.id);
    return Promise.all([
      queryClient.ensureQueryData(workListsQuery(orgIds)),
      queryClient.ensureQueryData(boardsQuery(orgIds)),
      deps.project && !deps.view
        ? queryClient.ensureQueryData(configQuery(deps.project))
        : Promise.resolve(null),
      ...(deps.item ? loadItem(queryClient, deps.item) : []),
    ]).catch(() => null);
  },
  component: WorkRoute,
});

function WorkRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SectionPage />
      {search.item && (
        <ItemPanel
          key={search.item}
          id={search.item}
          tab={search.itemTab ?? "overview"}
          onTab={(itemTab) => void navigate({ search: { ...search, itemTab }, replace: true })}
          onClose={() =>
            void navigate({ search: { ...search, item: undefined, itemTab: undefined } })
          }
          onExpand={() =>
            void navigate({
              to: "/work/$id",
              params: { id: search.item as string },
              search: search.itemTab ? { tab: search.itemTab } : {},
            })
          }
        />
      )}
    </div>
  );
}

/** The view the search asks for, under the panel. */
function SectionPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const project = search.project ?? null;
  const setProject = (p: string | null) =>
    void navigate({ search: { ...search, project: p ?? undefined } });
  switch (search.view) {
    case "backlog":
      return <BacklogPage projectId={project} onProject={setProject} />;
    case "ready":
      return <ReadyPage projectId={project} onProject={setProject} />;
    case "planning":
      return <PlanningPage projectId={project} onProject={setProject} />;
    case "done":
      return <DoneList projectId={project} onProject={setProject} />;
    default:
      if (project && !search.view) return <ProjectPage projectId={project} />;
      return project ? (
        <ProjectBoard
          projectId={project}
          layout={search.layout ?? "board"}
          onLayout={(layout) => void navigate({ search: { ...search, layout } })}
        />
      ) : (
        <ActiveAll />
      );
  }
}
