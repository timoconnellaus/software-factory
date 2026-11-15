// Chat in the new shell (.kim/mockups/chat-build-a-workflow-and-a-plugin.html): a new chat, or one
// opened (`?chat=`), with what it made beside it.
import { createRoute } from "@tanstack/react-router";
import { ChatPage } from "../components/flow/chat.tsx";
import { flowChatQuery, flowChatsQuery } from "../lib/flow-chat-queries.ts";
import { flowOrg } from "./flow.$orgId.tsx";

interface Search {
  chat?: string;
}

export const Route = createRoute({
  getParentRoute: () => flowOrg,
  path: "chat",
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s.chat === "string" && s.chat ? { chat: s.chat } : {},
  loaderDeps: ({ search }) => ({ chat: search.chat }),
  loader: ({ context: { queryClient }, params: { orgId }, deps: { chat } }) =>
    Promise.all([
      queryClient.ensureQueryData(flowChatsQuery(orgId)),
      ...(chat ? [queryClient.ensureQueryData(flowChatQuery(orgId, chat))] : []),
    ]).catch(() => null),
  component: ChatRoute,
});

function ChatRoute() {
  const { orgId } = Route.useParams();
  const { chat } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ChatPage
      orgId={orgId}
      chatId={chat}
      onOpen={(id) => void navigate({ search: id ? { chat: id } : {} })}
    />
  );
}
