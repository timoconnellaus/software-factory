// The reads the inbox, workflow editor, plugins and gateways add (spec 70), as TanStack Query
// options beside flow-queries.ts. Members, plugins and gateways are new operations: an engine that
// doesn't have them yet answers `unknown_operation`, which reads as an empty list, never an error.
import { queryOptions } from "@tanstack/react-query";
import { OpError, read } from "./op.ts";

/** An operation the engine doesn't have yet answers as if it had nothing to list. */
export async function orEmpty<T>(answer: Promise<T>, empty: T): Promise<T> {
  try {
    return await answer;
  } catch (error) {
    if (error instanceof OpError && error.code === "unknown_operation") return empty;
    throw error;
  }
}

export const flowMembersQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "members"],
    queryFn: () => orEmpty(read("flow.member.list", { orgId }), { members: [] }),
    staleTime: 60_000,
  });

export const flowPluginsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "plugins"],
    queryFn: () => orEmpty(read("flow.plugin.list", { orgId }), { plugins: [] }),
    staleTime: 10_000,
  });

/** One plugin with its code, by name (the server keys plugins by name). */
export const flowPluginQuery = (orgId: string, name: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "plugin", name],
    queryFn: () => read("flow.plugin.get", { orgId, name }),
    staleTime: 10_000,
  });

export const flowGatewaysQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "gateways"],
    queryFn: () => orEmpty(read("flow.gateway.list", { orgId }), { gateways: [] }),
    staleTime: 10_000,
  });
