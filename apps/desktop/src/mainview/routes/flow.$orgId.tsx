// One org in the new shell. The sidebar's projects and the org's agents (for owners' names) are read
// with the page's own reads, in the same batch.
import { createRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  flowAgentsQuery,
  flowInboxQuery,
  flowMembersQuery,
  flowProjectsQuery,
} from "../lib/flow-queries.ts";
import { flowLayout } from "./flow.tsx";

export const flowOrg = createRoute({
  getParentRoute: () => flowLayout,
  path: "$orgId",
  component: Outlet,
  loader: ({ context: { queryClient }, params: { orgId } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowProjectsQuery(orgId)),
      queryClient.ensureQueryData(flowAgentsQuery(orgId)),
      queryClient.ensureQueryData(flowInboxQuery(orgId)),
      queryClient.ensureQueryData(flowMembersQuery(orgId)),
    ]).catch(() => null),
});

export const flowOrgIndex = createRoute({
  getParentRoute: () => flowOrg,
  path: "/",
  beforeLoad: ({ params: { orgId } }) => {
    throw redirect({ to: "/flow/$orgId/work", params: { orgId } });
  },
});
