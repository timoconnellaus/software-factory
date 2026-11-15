// All orgs (the org strip's top button): what needs you, what is working and each org's counts.
import { createRoute } from "@tanstack/react-router";
import { AllOrgsPage } from "../components/flow/all-orgs.tsx";
import { flowAgentsQuery, flowInboxAllQuery, flowProjectsQuery } from "../lib/flow-queries.ts";
import { flowLayout } from "./flow.tsx";

export const Route = createRoute({
  getParentRoute: () => flowLayout,
  path: "orgs",
  loader: ({ context: { queryClient, session } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowInboxAllQuery()),
      ...session.orgs.flatMap((o) => [
        queryClient.ensureQueryData(flowProjectsQuery(o.id)),
        // The working agents' names.
        queryClient.ensureQueryData(flowAgentsQuery(o.id)),
      ]),
    ]).catch(() => null),
  component: AllOrgsPage,
});
