// Settings: This Mac (the account, the device key, this Mac's runner, the app and its updates) and
// Members (`?tab=members`).
import { createRoute } from "@tanstack/react-router";
import { SettingsPage } from "../components/flow/settings.tsx";
import { flowMembersQuery } from "../lib/flow-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "settings",
  validateSearch: (s: Record<string, unknown>): { tab?: "members" } =>
    s.tab === "members" ? { tab: "members" } : {},
  loader: ({ context: { queryClient }, params: { orgId } }) =>
    queryClient.ensureQueryData(flowMembersQuery(orgId)).catch(() => null),
  component: SettingsRoute,
});

function SettingsRoute() {
  const { orgId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <SettingsPage orgId={orgId} tab={tab === "members" ? "members" : "mac"} />;
}
