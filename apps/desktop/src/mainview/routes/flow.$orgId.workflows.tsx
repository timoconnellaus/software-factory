// The org's workflows (.kim/mockups/workflow-editor.html; the plan puts the list in Settings, which
// links here): every workflow with its statuses and projects, and one opened (`?workflow=`) in the
// same editor a project's Workflow tab has.
import { createRoute } from "@tanstack/react-router";
import { WorkflowsPage } from "../components/flow/workflow.tsx";
import { flowWorkflowsQuery } from "../lib/flow-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

interface Search {
  workflow?: string;
}

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "workflows",
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s.workflow === "string" && s.workflow ? { workflow: s.workflow } : {},
  loader: ({ context: { queryClient }, params: { orgId } }) =>
    queryClient.ensureQueryData(flowWorkflowsQuery(orgId)).catch(() => null),
  component: WorkflowsRoute,
});

function WorkflowsRoute() {
  const { orgId } = Route.useParams();
  const { workflow } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkflowsPage
      orgId={orgId}
      workflowId={workflow}
      onOpen={(id) => void navigate({ search: id ? { workflow: id } : {} })}
    />
  );
}
