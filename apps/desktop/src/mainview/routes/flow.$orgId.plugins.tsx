// Plugins in the new shell (.kim/mockups/plugins.html, gateways.html): the org's plugins, one
// opened (`?plugin=`) to read its code, and its gateways (`?tab=gateways`).
import { createRoute } from "@tanstack/react-router";
import { PluginsPage, type PluginsTab } from "../components/flow/plugins.tsx";
import { flowGatewaysQuery, flowPluginsQuery } from "../lib/flow-edit-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

interface Search {
  tab?: "gateways";
  plugin?: string;
}

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "plugins",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.tab === "gateways" ? { tab: "gateways" as const } : {}),
    ...(typeof s.plugin === "string" && s.plugin ? { plugin: s.plugin } : {}),
  }),
  loader: ({ context: { queryClient }, params: { orgId } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowPluginsQuery(orgId)),
      queryClient.ensureQueryData(flowGatewaysQuery(orgId)),
    ]).catch(() => null),
  component: PluginsRoute,
});

function PluginsRoute() {
  const { orgId } = Route.useParams();
  const { tab, plugin } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PluginsPage
      orgId={orgId}
      tab={(tab ?? "plugins") as PluginsTab}
      pluginId={plugin}
      onChoose={(next) =>
        void navigate({
          search: {
            ...(next.tab === "gateways" ? { tab: "gateways" as const } : {}),
            ...(next.plugin ? { plugin: next.plugin } : {}),
          },
        })
      }
    />
  );
}
