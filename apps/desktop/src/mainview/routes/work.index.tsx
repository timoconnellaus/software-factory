// Work (spec 41, design WorkActive/WorkActiveAll/WorkDone; spec 50 adds WorkBacklog/WorkReady/
// WorkProject): one route for the section's views. `view` picks Backlog, Planning, Ready, In the
// factory or Done; `project` alone is the project's page, and with a view it filters that view. In
// the factory is, for one project, its board by stage (or a list), and across projects a list by
// who each item waits on.

import { createRoute, useNavigate } from "@tanstack/react-router";
import { ActiveAll, DoneList, type Layout, ProjectBoard } from "../components/work-active.tsx";
import { BacklogPage, PlanningPage, ReadyPage } from "../components/work-backlog.tsx";
import { ProjectPage } from "../components/work-project.tsx";
import { deliveryStatusQuery } from "../lib/factory-queries.ts";
import { boardsQuery, configQuery, workflowQuery, workListsQuery } from "../lib/queries.ts";
import type { WorkView } from "../lib/work-board.ts";
import { workLayout } from "./_work.tsx";
import { ItemPanel, parseTab, type Tab } from "./work.$id.index.tsx";

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
  loaderDeps: ({ search }) => ({ project: search.project, view: search.view }),
  // The side panel's item isn't a dependency: the panel opens at once and loads inside (its
  // skeleton), so opening an item never waits on its reads.
  // The lists; a project's config and workflow on its page; on Planning, the workflow (its stage
  // labels) of each project with work being shaped.
  loader: ({ context: { queryClient, session }, deps }) => {
    const orgIds = session.orgs.map((o) => o.id);
    const board = queryClient.ensureQueryData(boardsQuery(orgIds));
    return Promise.all([
      // The page's own board: one project's when one is chosen.
      deps.project ? queryClient.ensureQueryData(boardsQuery(orgIds, deps.project)) : null,
      // Its board's lanes are the project's workflow's stages.
      deps.project && deps.view === "active"
        ? queryClient.ensureQueryData(workflowQuery(deps.project))
        : null,
      queryClient.ensureQueryData(workListsQuery(orgIds)),
      board,
      deps.project && !deps.view
        ? Promise.all([
            queryClient.ensureQueryData(configQuery(deps.project)),
            queryClient.ensureQueryData(workflowQuery(deps.project)),
          ])
        : Promise.resolve(null),
      deps.view === "planning"
        ? board.then((b) =>
            Promise.all(
              [
                ...new Set(b.items.filter((i) => i.status === "shaping").map((i) => i.projectId)),
              ].map((id) => queryClient.ensureQueryData(workflowQuery(id))),
            ),
          )
        : Promise.resolve(null),
      // The Held badge (spec 53): the babysitter's line, only for projects with work at merge.
      board.then((b) =>
        Promise.all(
          [...new Set(b.items.filter((i) => i.stage === "merge").map((i) => i.projectId))].map(
            (id) => queryClient.ensureQueryData(deliveryStatusQuery(id)).catch(() => null),
          ),
        ),
      ),
    ]).catch(() => null);
  },
  component: WorkRoute,
});

function WorkRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const close = () => {
    const id = search.item;
    // Replace: Back after closing goes where it went before the panel opened, not back into it.
    void navigate({
      search: { ...search, item: undefined, itemTab: undefined },
      replace: true,
    }).then(() =>
      // Focus goes back to the card or row the item opened from.
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-peek="${CSS.escape(id ?? "")}"]`)?.focus(),
      ),
    );
  };
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <SectionPage />
      {search.item && (
        <ItemPanel
          key={search.item}
          id={search.item}
          tab={search.itemTab ?? "overview"}
          onTab={(itemTab) => void navigate({ search: { ...search, itemTab }, replace: true })}
          onClose={close}
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
        <ActiveAll
          layout={search.layout ?? "board"}
          onLayout={(layout) => void navigate({ search: { ...search, layout } })}
        />
      );
  }
}
