// Chat (.kim/mockups/chat-build-a-workflow-and-a-plugin.html): the owner builds workflows and
// plugins by talking to an agent with the Plugin editor. The conversation is on the left: the
// person's messages in quiet bubbles on the right, the agent's replies as plain text under its name,
// and each thing it did as a one-line row with a tick. On the right, live, what this chat made: each
// workflow's statuses with their owners, and each plugin it built. Each message starts one run of
// the agent; while it runs, "Builder is working…" shows where the reply will go and sending waits.
// The chats themselves are in a compact switcher in the header, not a second sidebar.
import { agentName, ownerOf, personName } from "@software-factory/client/flow";
import {
  type ChatTurn,
  chatTurns,
  didCount,
  type FlowChatView,
} from "@software-factory/client/flow-chat";
import { Button } from "@software-factory/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@software-factory/ui/components/dropdown-menu";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderIcon,
  PlusIcon,
  PuzzleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { flowChatQuery, flowChatsQuery } from "../../lib/flow-chat-queries.ts";
import { flowPluginsQuery } from "../../lib/flow-edit-queries.ts";
import {
  flowProjectsQuery,
  flowWorkflowQuery,
  useFlowRefresh,
  useNames,
} from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { OwnerMark, PageHeader, Pill, StatusMark } from "./parts.tsx";

const failed = (e: unknown, fallback: string) =>
  e instanceof OpError || e instanceof Error ? e.message : fallback;

/** What a new chat suggests asking. */
const SUGGESTION =
  "Set up a workflow for launch content: I write a brief, an agent drafts it, and I edit it before it's published.";

/**
 * Starts a chat with `text`: the org's builder (created if it has none), then the chat with its
 * first message. Answers the new chat's id, with its view already in the cache.
 */
export function useStartChat(orgId: string) {
  const client = useQueryClient();
  const refresh = useFlowRefresh(orgId);
  return async (text: string): Promise<string> => {
    const builder = await op(
      "flow.agent.ensureBuilder",
      { orgId },
      { idempotencyKey: submitKey() },
    );
    const view = await op(
      "flow.chat.create",
      { orgId, agentId: builder.id, text },
      { idempotencyKey: submitKey() },
    );
    client.setQueryData(flowChatQuery(orgId, view.chat.id).queryKey, view);
    void refresh();
    return view.chat.id;
  };
}

export function ChatPage({
  orgId,
  chatId,
  onOpen,
}: {
  orgId: string;
  chatId: string | undefined;
  onOpen: (chatId: string | undefined) => void;
}) {
  const names = useNames(orgId);
  const chats = useQuery(flowChatsQuery(orgId));
  const chat = useQuery({ ...flowChatQuery(orgId, chatId ?? ""), enabled: !!chatId });
  // A new chat talks to the org's builder: made now if the org has none, so Chat needs no setup.
  const builder = useQuery({
    queryKey: ["flow", orgId, "builder"],
    queryFn: () => op("flow.agent.ensureBuilder", { orgId }),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: !chatId,
  });
  const view = chatId ? chat.data : undefined;
  const agentId = view?.chat.agentId ?? builder.data?.id;
  const agent = agentId
    ? names.agents.some((a) => a.id === agentId)
      ? agentName(names, agentId)
      : (builder.data?.name ?? "Builder")
    : "Builder";
  const current = chats.data?.chats.find((c) => c.id === chatId);
  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="chat-page">
      <PageHeader title="Chat">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="md"
              className="min-w-0 max-w-[420px] gap-1 px-2 font-normal text-ink-muted"
              data-testid="chat-switcher"
            >
              <span className="truncate">
                {chatId ? (view?.chat.title ?? current?.title ?? "") : "New chat"}
              </span>
              <ChevronDownIcon className="flex-none" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[360px]">
            <DropdownMenuItem onSelect={() => onOpen(undefined)} data-testid="new-chat">
              <PlusIcon />
              New chat
            </DropdownMenuItem>
            {(chats.data?.chats.length ?? 0) > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[11.5px] text-ink-faint">
                  Recent
                </DropdownMenuLabel>
                {chats.data?.chats.slice(0, 15).map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onSelect={() => onOpen(c.id)}
                    className={cn(c.id === chatId && "font-medium")}
                    data-testid="recent-chat"
                  >
                    <span className="truncate">{c.title}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        <Pill data-testid="chat-agent">
          <OwnerMark name={agent} kind="agent" />
          {agent}
        </Pill>
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <Conversation
          orgId={orgId}
          chatId={chatId}
          agent={agent}
          loading={!!chatId && !chat.data && !chat.error}
          error={chat.error ? failed(chat.error, "Couldn't load this chat") : null}
          view={view}
          onStarted={onOpen}
        />
        <LivePane orgId={orgId} agent={agent} view={view} />
      </div>
    </main>
  );
}

function Conversation({
  orgId,
  chatId,
  agent,
  loading,
  error,
  view,
  onStarted,
}: {
  orgId: string;
  chatId: string | undefined;
  agent: string;
  loading: boolean;
  error: string | null;
  view: FlowChatView | undefined;
  onStarted: (chatId: string) => void;
}) {
  const client = useQueryClient();
  const start = useStartChat(orgId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const turns = view ? chatTurns(view.messages, view.working) : [];
  const working = view?.working ?? false;
  const last = view?.messages.at(-1)?.seq ?? 0;
  // Keep the newest message in view as the conversation grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message or the working state arrives
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [last, working]);

  async function send() {
    const said = text.trim();
    if (!said || sending || working) return;
    setSending(true);
    try {
      if (!chatId) {
        onStarted(await start(said));
      } else {
        const next = await op(
          "flow.chat.send",
          { orgId, chatId, text: said },
          { idempotencyKey: submitKey() },
        );
        client.setQueryData(flowChatQuery(orgId, chatId).queryKey, next);
        void client.invalidateQueries({ queryKey: flowChatsQuery(orgId).queryKey });
      }
      setText("");
    } catch (e) {
      toast.error(failed(e, "Couldn't send that"));
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      className="flex min-w-0 flex-1 flex-col border-line-soft border-r bg-panel"
      data-testid="chat"
    >
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="flex flex-col gap-3.5" data-testid="chat-messages">
          {error ? (
            <p className="text-bad">{error}</p>
          ) : loading ? (
            <Skeleton className="h-16 w-full" />
          ) : turns.length === 0 ? (
            <p className="mt-6 max-w-[560px] text-ink-muted" data-testid="chat-empty">
              Tell {agent} what you want the app to do, in plain words. For example: “{SUGGESTION}”
            </p>
          ) : (
            turns.map((t) => <Turn key={`${t.kind}-${t.seq}`} turn={t} agent={agent} />)
          )}
          {view?.truncated && (
            <p className="text-center text-[12px] text-ink-faint">Older messages aren't shown.</p>
          )}
          <div ref={end} />
        </div>
      </div>
      <form
        className="mx-6 mb-4.5 flex items-end gap-2 rounded-xl border border-line bg-panel py-1.5 pr-1.5 pl-3.5 focus-within:border-line-strong"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        data-testid="chat-box"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={
            working
              ? `${agent} is working on your last message…`
              : chatId
                ? "Say what you want to change…"
                : "Say what you want the app to do…"
          }
          aria-label="Message"
          className="max-h-40 min-h-8 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
          data-testid="chat-input"
        />
        <Button
          type="submit"
          size="icon-sm"
          disabled={!text.trim() || sending || working}
          aria-label="Send"
          data-testid="chat-send"
        >
          {sending ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}
        </Button>
      </form>
    </section>
  );
}

function Turn({ turn, agent }: { turn: ChatTurn; agent: string }) {
  if (turn.kind === "person") {
    return (
      <div
        className="max-w-[80%] self-end whitespace-pre-wrap rounded-xl bg-window px-3.5 py-2.5"
        data-testid="chat-person"
      >
        {turn.text}
      </div>
    );
  }
  return (
    <div className="max-w-[92%]" data-testid="chat-agent-turn">
      <div className="mb-1 flex items-center gap-1.5 font-semibold">
        <OwnerMark name={agent} kind="agent" />
        {agent}
      </div>
      {turn.text !== null && (
        <p
          className={cn("m-0 whitespace-pre-wrap", turn.failed && "text-bad")}
          data-testid={turn.failed ? "chat-failed" : "chat-reply"}
        >
          {turn.failed && <CircleAlertIcon className="-mt-0.5 mr-1.5 inline size-4" />}
          {turn.text}
        </p>
      )}
      {turn.dids.map((d) => (
        <div
          key={d.seq}
          className="mt-1.5 flex items-center gap-2 rounded-[9px] border border-line px-3 py-2 text-[12.5px]"
          data-testid="chat-did"
        >
          <CircleCheckIcon className="size-4 flex-none text-ok" />
          <span className="truncate">{d.text}</span>
        </div>
      ))}
      {/* While the run goes, what it did so far shows first, then where its reply will go. */}
      {turn.working && (
        <p
          className={cn(
            "m-0 flex items-center gap-2 text-ink-muted",
            turn.dids.length > 0 && "mt-2",
          )}
          data-testid="chat-working"
        >
          <LoaderIcon className="size-3.5 animate-spin" />
          {agent} is working…
        </p>
      )}
    </div>
  );
}

// ---- The live pane ------------------------------------------------------------------------------

function LivePane({
  orgId,
  agent,
  view,
}: {
  orgId: string;
  agent: string;
  view: FlowChatView | undefined;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const names = useNames(orgId);
  const projects = useQuery(flowProjectsQuery(orgId));
  const plugins = useQuery(flowPluginsQuery(orgId));
  const made = view?.made ?? { workflows: [], plugins: [] };
  const workflows = useQueries({
    queries: made.workflows.map((w) => flowWorkflowQuery(orgId, w.id)),
  });
  // When the agent does something, what this pane shows is read again.
  const dids = didCount(view?.messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read only when a did row arrives
  useEffect(() => {
    if (dids === 0) return;
    for (const key of [["workflow"], ["workflows"], ["plugins"], ["projects"], ["agents"]]) {
      void client.invalidateQueries({ queryKey: ["flow", orgId, ...key] });
    }
  }, [dids]);

  const openWorkflow = (workflowId: string) => {
    const project = projects.data?.projects.find((p) => p.workflowId === workflowId);
    if (project)
      void navigate({
        to: "/flow/$orgId/p/$projectId",
        params: { orgId, projectId: project.id },
        search: { view: "workflow" },
      });
    else
      void navigate({
        to: "/flow/$orgId/workflows",
        params: { orgId },
        search: { workflow: workflowId },
      });
  };

  const nothing = made.workflows.length === 0 && made.plugins.length === 0;
  return (
    <aside
      className="w-[440px] flex-none overflow-auto bg-board px-5 py-4.5 max-[1100px]:w-[360px]"
      data-testid="chat-live"
    >
      {nothing ? (
        <p className="text-[12.5px] text-ink-muted" data-testid="chat-live-empty">
          What {agent} sets up in this chat shows here as it happens: the workflows with their
          statuses and owners, and the plugins it builds.
        </p>
      ) : (
        <>
          {made.workflows.map((w, i) => {
            const read = workflows[i]?.data;
            const statuses = read?.workflow.statuses ?? [];
            return (
              <section key={w.id} className="mb-5" data-testid="live-workflow">
                <h4 className="mb-2 font-semibold text-[11px] text-ink-faint uppercase tracking-[.03em]">
                  {read?.workflow.name ?? w.name} · Live
                </h4>
                <button
                  type="button"
                  className="flex w-full flex-col gap-1.5 text-left"
                  onClick={() => openWorkflow(w.id)}
                  title="Open this workflow"
                  data-testid="open-live-workflow"
                >
                  {!read ? (
                    <Skeleton className="h-9 w-full" />
                  ) : (
                    statuses.map((s, n) => {
                      const owner = ownerOf(names, s.owner);
                      const ownerName =
                        s.owner.kind === "person" ? personName(names, s.owner.userId) : owner.name;
                      return (
                        <span
                          key={s.id}
                          className="flex items-center gap-2 rounded-[9px] border border-line bg-panel px-3 py-2 hover:border-line-strong"
                          data-testid="live-status"
                        >
                          <StatusMark index={n} count={statuses.length} />
                          <span className="truncate">{s.name}</span>
                          <span className="ml-auto flex flex-none items-center gap-1.5 text-[12px] text-ink-muted">
                            {owner.kind === "none" ? (
                              <span
                                aria-hidden
                                className="inline-grid size-[17px] place-items-center rounded-[5px] border border-line text-[9px]"
                              >
                                –
                              </span>
                            ) : (
                              <OwnerMark name={ownerName} kind={owner.kind} />
                            )}
                            {ownerName}
                          </span>
                        </span>
                      );
                    })
                  )}
                </button>
              </section>
            );
          })}
          {made.plugins.length > 0 && (
            <section data-testid="live-plugins">
              <h4 className="mb-2 font-semibold text-[11px] text-ink-faint uppercase tracking-[.03em]">
                Plugins built in this chat
              </h4>
              <div className="flex flex-col gap-2">
                {made.plugins.map((p) => {
                  const found = plugins.data?.plugins.find((x) => x.id === p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        void navigate({ to: "/flow/$orgId/plugins", params: { orgId } })
                      }
                      className="rounded-[9px] border border-ok bg-panel px-3 py-2.5 text-left shadow-[0_0_0_2px_color-mix(in_srgb,var(--ok)_14%,transparent)]"
                      data-testid="live-plugin"
                    >
                      <span className="flex items-center gap-2 font-semibold">
                        <PuzzleIcon className="size-4 flex-none" />
                        {found?.name ?? p.name}
                      </span>
                      {found?.request && (
                        <span className="mt-1 block text-[12.5px] text-ink-muted">
                          “{found.request}”
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          <p className="mt-3.5 text-[12px] text-ink-muted">
            Changes are live as soon as {agent} makes them.
          </p>
        </>
      )}
    </aside>
  );
}
