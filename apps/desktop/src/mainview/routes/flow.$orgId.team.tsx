// Team (.kim/mockups/team-an-agent.html): Agents, Runners and People. `?tab=` picks the tab (Agents
// without it), `?agent=` the agent shown (else the first).
import { createRoute } from "@tanstack/react-router";
import { TeamPage, type TeamTab } from "../components/flow/team.tsx";
import {
  flowAgentRunsQuery,
  flowAgentsQuery,
  flowInboxAllQuery,
  flowMembersQuery,
} from "../lib/flow-queries.ts";
import { runnersQuery } from "../lib/queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

interface Search {
  tab?: Exclude<TeamTab, "agents">;
  agent?: string;
}

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "team",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.tab === "runners" || s.tab === "people" ? { tab: s.tab } : {}),
    ...(typeof s.agent === "string" && s.agent ? { agent: s.agent } : {}),
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab, agent: search.agent }),
  loader: async ({ context: { queryClient }, params: { orgId }, deps: { tab, agent } }) => {
    if (tab === "runners") return queryClient.ensureQueryData(runnersQuery()).catch(() => null);
    if (tab === "people") return queryClient.ensureQueryData(flowMembersQuery(orgId));
    const [agents] = await Promise.all([
      queryClient.ensureQueryData(flowAgentsQuery(orgId)),
      queryClient.ensureQueryData(flowInboxAllQuery()),
    ]).catch(() => [null]);
    // The agent shown: its recent runs.
    const shown = agent ?? agents?.agents[0]?.id;
    if (shown)
      await queryClient.ensureQueryData(flowAgentRunsQuery(orgId, shown)).catch(() => null);
    return null;
  },
  component: TeamRoute,
});

function TeamRoute() {
  const { orgId } = Route.useParams();
  const { tab, agent } = Route.useSearch();
  return <TeamPage orgId={orgId} tab={tab ?? "agents"} agentId={agent} />;
}
