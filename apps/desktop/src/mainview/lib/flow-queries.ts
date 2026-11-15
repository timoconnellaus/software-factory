// The new core's reads (spec 70) as TanStack Query options, through `read()` like every other read.
// What the board and an open item show is re-read every few seconds while the window shows it
// (react-query stops polling when the window is hidden) and after any write the app makes.
import type { Names } from "@software-factory/client/flow";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { read } from "./op.ts";
import { useSession } from "./session.ts";

/** How often the board, an open item and the inbox count are re-read while visible. */
export const FLOW_POLL_MS = 5_000;

export const flowProjectsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "projects"],
    queryFn: () => read("flow.project.list", { orgId }),
    staleTime: 30_000,
  });

export const flowAgentsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "agents"],
    queryFn: () => read("flow.agent.list", { orgId }),
    staleTime: 60_000,
  });

export const flowWorkflowsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "workflows"],
    queryFn: () => read("flow.workflow.list", { orgId }),
    staleTime: 60_000,
  });

export const flowWorkflowQuery = (orgId: string, workflowId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "workflow", workflowId],
    queryFn: () => read("flow.workflow.get", { orgId, workflowId }),
    staleTime: 60_000,
  });

export const flowBoardQuery = (orgId: string, projectId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "board", projectId],
    queryFn: () => read("flow.board.get", { orgId, projectId }),
    staleTime: 2_000,
    refetchInterval: FLOW_POLL_MS,
  });

export const flowItemQuery = (orgId: string, itemId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "item", itemId],
    queryFn: () => read("flow.item.get", { orgId, itemId }),
    staleTime: 2_000,
    refetchInterval: FLOW_POLL_MS,
  });

export const flowTimelineQuery = (orgId: string, itemId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "item", itemId, "timeline"],
    queryFn: () => read("flow.timeline.get", { orgId, itemId }),
    staleTime: 2_000,
    refetchInterval: FLOW_POLL_MS,
  });

export const flowInboxQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "inbox"],
    queryFn: () => read("flow.inbox.get", { orgId }),
    staleTime: 2_000,
    refetchInterval: FLOW_POLL_MS,
  });

/** After a write: everything the org's flow screens show is read again. */
export function useFlowRefresh(orgId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["flow", orgId] });
}

/** Who the screens can name: the signed-in person and the org's agents. */
export function useNames(orgId: string): Names {
  const session = useSession();
  const agents = useQuery(flowAgentsQuery(orgId));
  return {
    me: { id: session.user.id, name: session.user.name },
    agents: agents.data?.agents ?? [],
  };
}
