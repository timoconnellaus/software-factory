// Chat's reads (migration 0433) as TanStack Query options. A chat is re-read every 3 seconds only
// while its agent's run is in flight and the window shows it (react-query stops polling when the
// window is hidden); otherwise only after something the person does.
import { queryOptions } from "@tanstack/react-query";
import { orEmpty } from "./flow-edit-queries.ts";
import { read } from "./op.ts";

/** How often a chat is re-read while its agent is working. */
export const CHAT_POLL_MS = 3_000;

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
