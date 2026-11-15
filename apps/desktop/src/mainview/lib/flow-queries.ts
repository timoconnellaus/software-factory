// The new core's reads (spec 70) as TanStack Query options, through `read()` like every other read.
// What the board and an open item show is re-read every few seconds while the window shows it
// (react-query stops polling when the window is hidden) and after any write the app makes.
import type { FlowInboxAll, FlowRun, Names } from "@software-factory/client/flow";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { OpError, read } from "./op.ts";
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

/**
 * A read the server may not have yet (`flow.member.list`, `flow.inbox.all`, `flow.run.list` by
 * agent): a refusal (an unknown operation, an input it doesn't take yet) reads as `fallback`, so the
 * screen shows its empty state, never an error.
 */
async function orEmpty<T>(read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof OpError) return fallback;
    throw error;
  }
}

/** The org's members, by name (empty until the server has `flow.member.list`). */
export const flowMembersQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "members"],
    queryFn: () => orEmpty(read("flow.member.list", { orgId }), { members: [] }),
    staleTime: 5 * 60_000,
  });

/** Every org's waiting and working items, for All orgs (empty until the server has it). */
export const flowInboxAllQuery = () =>
  queryOptions({
    queryKey: ["flow", "all", "inbox"],
    queryFn: () => orEmpty<FlowInboxAll>(read("flow.inbox.all", {}), { orgs: [] }),
    staleTime: 2_000,
    refetchInterval: FLOW_POLL_MS,
  });

/** An agent's recent runs, newest first; null when the server can't list them by agent yet. */
export const flowAgentRunsQuery = (orgId: string, agentId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "agent", agentId, "runs"],
    queryFn: () =>
      orEmpty<{ runs: FlowRun[] } | null>(
        read("flow.run.list", { orgId, agentId, limit: 20 }),
        null,
      ),
    staleTime: 5_000,
    refetchInterval: FLOW_POLL_MS,
  });

/** After a write: everything the org's flow screens show is read again. */
export function useFlowRefresh(orgId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["flow", orgId] });
}

/** Who the screens can name: the signed-in person, the org's agents and its members. */
export function useNames(orgId: string): Names {
  const session = useSession();
  const agents = useQuery(flowAgentsQuery(orgId));
  const members = useQuery(flowMembersQuery(orgId));
  return {
    me: { id: session.user.id, name: session.user.name },
    agents: agents.data?.agents ?? [],
    members: members.data?.members ?? [],
  };
}
