// Work: the org's first project's board. With no project yet, one line; the sidebar's + makes one.
import { createRoute, redirect } from "@tanstack/react-router";
import { PageHeader } from "../components/flow/parts.tsx";
import { flowProjectsQuery } from "../lib/flow-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "work",
  loader: async ({ context: { queryClient }, params: { orgId } }) => {
    const { projects } = await queryClient.ensureQueryData(flowProjectsQuery(orgId));
    const first = projects[0];
    if (first)
      throw redirect({
        to: "/flow/$orgId/p/$projectId",
        params: { orgId, projectId: first.id },
        replace: true,
      });
  },
  component: () => (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="work-empty">
      <PageHeader title="Work" />
      <p className="p-6 text-ink-muted">No projects yet. Add one with the + beside Projects.</p>
    </main>
  ),
});
