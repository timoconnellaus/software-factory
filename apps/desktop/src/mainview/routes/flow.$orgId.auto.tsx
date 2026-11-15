// Auto in the new shell (.kim/mockups/auto-schedules.html): the org's schedules, and its triggers
// (`?tab=triggers`).
import { createRoute } from "@tanstack/react-router";
import { AutoPage } from "../components/flow/auto.tsx";
import { flowSchedulesQuery } from "../lib/flow-auto-queries.ts";
import { flowProjectsQuery } from "../lib/flow-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

interface Search {
  tab?: "triggers";
}

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "auto",
  validateSearch: (s: Record<string, unknown>): Search =>
    s.tab === "triggers" ? { tab: "triggers" } : {},
  loader: ({ context: { queryClient }, params: { orgId } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowSchedulesQuery(orgId)),
      queryClient.ensureQueryData(flowProjectsQuery(orgId)),
    ]).catch(() => null),
  component: AutoRoute,
});

function AutoRoute() {
  const { orgId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AutoPage
      orgId={orgId}
      tab={tab ?? "schedules"}
      onTab={(t) => void navigate({ search: t === "triggers" ? { tab: "triggers" } : {} })}
    />
  );
}
