// Chat's reads (migrations 0433, 0437) as TanStack Query options. A chat is re-read every 3 seconds
// only while its run is in flight and the window shows it (react-query stops polling when the window
// is hidden); otherwise only after something the person does. The run's events, for what the model
// is doing, are read every 2 seconds while it runs, and once more on asking for a finished run's.
import { readNewEvents } from "@software-factory/client/flow-run";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { orEmpty } from "./flow-edit-queries.ts";
import { read } from "./op.ts";

/** How often a chat is re-read while its run is working. */
export const CHAT_POLL_MS = 3_000;
/** How often a working run's events are read. */
export const CHAT_STEPS_POLL_MS = 2_000;

export const flowChatsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "chats"],
    queryFn: () => orEmpty(read("flow.chat.list", { orgId }), { chats: [] }),
    staleTime: 10_000,
  });

export const flowChatQuery = (orgId: string, chatId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "chat", chatId],
    queryFn: () => read("flow.chat.get", { orgId, chatId }),
    staleTime: 1_000,
    refetchInterval: (query) => (query.state.data?.working ? CHAT_POLL_MS : false),
  });

/** The models and efforts the pickers offer: fixed on the server, so read once. */
export const flowChatOptionsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "chat-options"],
    queryFn: () => read("flow.chat.options", { orgId }),
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * A chat run's events, read on from the last one already held. `live` (the run is working) polls
 * every 2 seconds until the run says it is done; a finished run's are read once and kept.
 */
export const chatStepsQuery = (
  client: QueryClient,
  orgId: string,
  runId: string,
  live: boolean,
) => {
  const queryKey = ["flow", orgId, "chat-steps", runId] as const;
  return queryOptions({
    queryKey,
    queryFn: () =>
      readNewEvents(
        (after) =>
          read("flow.run.events", { orgId, runId, ...(after !== undefined ? { after } : {}) }),
        client.getQueryData<Awaited<ReturnType<typeof readNewEvents>>>(queryKey)?.events ?? [],
      ),
    staleTime: live ? 0 : Number.POSITIVE_INFINITY,
    refetchInterval: (query) =>
      live || (query.state.data && !query.state.data.done) ? CHAT_STEPS_POLL_MS : false,
  });
};
