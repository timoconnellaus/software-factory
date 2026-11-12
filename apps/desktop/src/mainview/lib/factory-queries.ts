// The Factory and Settings sections' reads (spec 41, slices 5 and 6), through `read()` like the
// rest of lib/queries.ts. Kept apart so the sections can grow without touching the shell's reads.
import { queryOptions } from "@tanstack/react-query";
import { read } from "./op.ts";

/** Each project's merge queue, head first (ADR 0330), keyed by project. */
export const mergeQueuesQuery = (projectIds: string[]) =>
  queryOptions({
    queryKey: ["mergeQueue", projectIds],
    queryFn: async () => {
      const lists = await Promise.all(
        projectIds.map((projectId) => read("mergeQueue.list", { projectId })),
      );
      return projectIds.map((projectId, i) => ({ projectId, entries: lists[i]?.entries ?? [] }));
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

/** A project's config (ADR 0370): the current version's document, history and pending saves. */
export const configQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["config", projectId],
    queryFn: () => read("config.get", { projectId }),
    staleTime: 30_000,
  });
