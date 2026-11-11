// TanStack Query options for every read the dashboard makes. All reads are operations.
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { op } from "./op.ts";
import type { Project } from "./ops.ts";

export const inboxQuery = () =>
  queryOptions({
    queryKey: ["inbox"],
    queryFn: () => op("inbox.list", {}),
    refetchInterval: 15_000,
  });

export const workItemQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId],
    queryFn: () => op("workItem.get", { workItemId }),
    refetchInterval: 10_000,
  });

export const timelineQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId, "timeline"],
    queryFn: () => op("workItem.timeline", { workItemId }),
    refetchInterval: 10_000,
  });

/** Every project in every org the user belongs to. */
export const projectsQuery = (orgIds: string[]) =>
  queryOptions({
    queryKey: ["projects", orgIds],
    queryFn: async (): Promise<Project[]> => {
      const lists = await Promise.all(orgIds.map((orgId) => op("project.list", { orgId })));
      return lists.flatMap((l) => l.projects);
    },
    staleTime: 60_000,
  });

export const workListQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["work", orgId],
    queryFn: () => op("workItem.list", { orgId, limit: 100 }),
    refetchInterval: 15_000,
  });

export const runnersQuery = () =>
  queryOptions({
    queryKey: ["runners"],
    queryFn: () => op("runner.list", {}),
    staleTime: 30_000,
  });

/** The Setup checklist for an org, live (GitHub, project, policy, runner, factory/verify). */
export const setupStatusQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["setup", orgId],
    queryFn: () => op("setup.status", { orgId }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

export const reposQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["repos", orgId],
    queryFn: () => op("github.repos", { orgId }),
    staleTime: 30_000,
  });

export const routingQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["routing", projectId],
    queryFn: () => op("workItem.previewRouting", { projectId }),
    staleTime: 10_000,
  });

/** After a decision: everything that shows gates, items or counts. */
export function useRefreshAfterDecision() {
  const queryClient = useQueryClient();
  return (workItemId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["inbox"] }),
      queryClient.invalidateQueries({ queryKey: ["work"] }),
      workItemId
        ? queryClient.invalidateQueries({ queryKey: ["workItem", workItemId] })
        : Promise.resolve(),
    ]);
}
