// TanStack Query options for every read the dashboard makes. All reads are operations, through
// `read()` (batched per tick). Route loaders `ensureQueryData` everything their page renders, so a
// navigation fetches in one request and pages render from the cache; a cached page shows at once
// and refreshes in the background once its `staleTime` has passed.
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { getSession } from "#/server/fns";
import { read } from "./op.ts";
import type { Project } from "./ops.ts";

/**
 * The signed-in user and their orgs. Fetched once per page load (on the server for the first
 * render, then carried to the browser with the rest of the cache), so client navigations don't
 * wait on it; `_app` re-checks it in the background once it is stale. Operations check the session
 * on every call regardless.
 */
export const sessionQuery = () =>
  queryOptions({
    queryKey: ["session"],
    queryFn: () => getSession(),
    staleTime: 5 * 60_000,
  });

export const inboxQuery = () =>
  queryOptions({
    queryKey: ["inbox"],
    queryFn: () => read("inbox.list", {}),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

export const workItemQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId],
    queryFn: () => read("workItem.get", { workItemId }),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

export const timelineQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId, "timeline"],
    queryFn: () => read("workItem.timeline", { workItemId }),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

/** Every project in every org the user belongs to. */
export const projectsQuery = (orgIds: string[]) =>
  queryOptions({
    queryKey: ["projects", orgIds],
    queryFn: async (): Promise<Project[]> => {
      const lists = await Promise.all(orgIds.map((orgId) => read("project.list", { orgId })));
      return lists.flatMap((l) => l.projects);
    },
    staleTime: 60_000,
  });

export const workListQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["work", orgId],
    queryFn: () => read("workItem.list", { orgId, limit: 100 }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

export const runnersQuery = () =>
  queryOptions({
    queryKey: ["runners"],
    queryFn: () => read("runner.list", {}),
    staleTime: 30_000,
  });

/** The Setup checklist for an org, live (GitHub, project, policy, runner, factory/verify). */
export const setupStatusQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["setup", orgId],
    queryFn: () => read("setup.status", { orgId }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

export const reposQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["repos", orgId],
    queryFn: () => read("github.repos", { orgId }),
    staleTime: 30_000,
  });

export const routingQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["routing", projectId],
    queryFn: () => read("workItem.previewRouting", { projectId }),
    staleTime: 10_000,
  });

/** The project's open PRs no work item owns yet (New work's Attach list, spec 05). */
export const openPullsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["open-pulls", projectId],
    queryFn: () => read("github.openPullRequests", { projectId }),
    staleTime: 30_000,
  });

/** What `/attach` shows for one PR (spec 05). */
export const attachPreviewQuery = (repo: { owner: string; name: string }, prNumber: number) =>
  queryOptions({
    queryKey: ["attach", repo.owner, repo.name, prNumber],
    queryFn: () => read("workItem.previewAttach", { repo, prNumber }),
    staleTime: 10_000,
    retry: false,
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
