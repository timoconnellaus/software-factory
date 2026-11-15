// Inbox in the new shell (.kim/mockups/inbox.html): "Needs you" with the chosen item (`?item=`)
// decision first, and "Done" (`?tab=done`).
import { createRoute } from "@tanstack/react-router";
import { InboxPage, type InboxTab } from "../components/flow/inbox.tsx";
import { flowInboxQuery, flowProjectsQuery, flowWorkflowsQuery } from "../lib/flow-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

interface Search {
  tab?: "done";
  item?: string;
}

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "inbox",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.tab === "done" ? { tab: "done" as const } : {}),
    ...(typeof s.item === "string" && s.item ? { item: s.item } : {}),
  }),
  // The rows' questions name each item's status: the org's workflows, in the same batch.
  loader: ({ context: { queryClient }, params: { orgId } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowInboxQuery(orgId)),
      queryClient.ensureQueryData(flowProjectsQuery(orgId)),
      queryClient.ensureQueryData(flowWorkflowsQuery(orgId)),
    ]).catch(() => null),
  component: InboxRoute,
});

function InboxRoute() {
  const { orgId } = Route.useParams();
  const { tab, item } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <InboxPage
      orgId={orgId}
      tab={(tab ?? "needs-you") as InboxTab}
      itemId={item}
      onChoose={(next) =>
        void navigate({
          search: {
            ...(next.tab === "done" ? { tab: "done" as const } : {}),
            ...(next.item ? { item: next.item } : {}),
          },
        })
      }
    />
  );
}
