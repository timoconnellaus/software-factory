// A project's board (or its list), with an item open as a panel on the right (`?item=`).
import { createRoute } from "@tanstack/react-router";
import { ProjectPage } from "../components/flow/board.tsx";
import { flowBoardQuery, flowProjectsQuery, flowWorkflowQuery } from "../lib/flow-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

interface Search {
  view?: "list";
  item?: string;
}

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "p/$projectId",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.view === "list" ? { view: "list" as const } : {}),
    ...(typeof s.item === "string" && s.item ? { item: s.item } : {}),
  }),
  // The item panel loads inside itself (its skeleton): opening an item never waits on its reads.
  loader: ({ context: { queryClient }, params: { orgId, projectId } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowBoardQuery(orgId, projectId)),
      // The workflow's name in the header: the project (the org's loader reads it) names it.
      queryClient.ensureQueryData(flowProjectsQuery(orgId)).then(({ projects }) => {
        const project = projects.find((p) => p.id === projectId);
        return project
          ? queryClient.ensureQueryData(flowWorkflowQuery(orgId, project.workflowId))
          : null;
      }),
    ]).catch(() => null),
  component: ProjectRoute,
});

function ProjectRoute() {
  const { orgId, projectId } = Route.useParams();
  const { view, item } = Route.useSearch();
  return (
    <ProjectPage
      key={projectId}
      orgId={orgId}
      projectId={projectId}
      view={view === "list" ? "list" : "board"}
      itemId={item}
    />
  );
}
