// An item as a full page: the panel's expand button opens it, its collapse button goes back.
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { ItemPage } from "../components/flow/item.tsx";
import {
  flowItemQuery,
  flowProjectsQuery,
  flowTimelineQuery,
  flowWorkflowQuery,
} from "../lib/flow-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "p/$projectId/i/$itemId",
  loader: ({ context: { queryClient }, params: { orgId, projectId, itemId } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowItemQuery(orgId, itemId)),
      queryClient.ensureQueryData(flowTimelineQuery(orgId, itemId)),
      // The statuses' names: the project names its workflow.
      queryClient.ensureQueryData(flowProjectsQuery(orgId)).then(({ projects }) => {
        const project = projects.find((p) => p.id === projectId);
        return project
          ? queryClient.ensureQueryData(flowWorkflowQuery(orgId, project.workflowId))
          : null;
      }),
    ]).catch(() => null),
  component: ItemRoute,
});

function ItemRoute() {
  const { orgId, projectId, itemId } = Route.useParams();
  const projects = useQuery(flowProjectsQuery(orgId));
  const project = projects.data?.projects.find((p) => p.id === projectId);
  return <ItemPage orgId={orgId} itemId={itemId} project={project} />;
}
