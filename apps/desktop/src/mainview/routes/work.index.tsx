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

interface Search {
  view?: WorkView;
  project?: string;
  layout?: Layout;
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
  }),
  loaderDeps: ({ search }) => ({ project: search.project, view: search.view }),
  // The lists, and a project's config (its workflow) on its page.
  loader: ({ context: { queryClient, session }, deps }) => {
    const orgIds = session.orgs.map((o) => o.id);
    return Promise.all([
      queryClient.ensureQueryData(workListsQuery(orgIds)),
      queryClient.ensureQueryData(boardsQuery(orgIds)),
      deps.project && !deps.view
        ? queryClient.ensureQueryData(configQuery(deps.project))
        : Promise.resolve(null),
    ]).catch(() => null);
  },
  component: WorkRoute,
});

function WorkRoute() {
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
