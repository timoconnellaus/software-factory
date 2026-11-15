// Chat (spec 70, "Chat"): a conversation with a model, as in an ordinary Claude chat. The person picks
// the model and the effort beside the send button; each message is one run on their runner, which
// can also act on the app (create items, set up a workflow, build a plugin) when that is what they
// want. The person's messages sit in quiet bubbles on the right; the replies are Markdown under the
// model's name, with each thing it changed as a one-line row. While a run goes, its latest steps
// show in plain words; once the reply lands they fold into "Did N things". Beside the conversation,
// only once the chat has made something, what it made. The chats themselves are in a compact
// switcher in the header.
import {
  type ChatTurn,
  chatTurns,
  choiceLabel,
  type FlowChatOptions,
  type FlowChatView,
  madeAnything,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  flowChatOptionsQuery,
  flowChatQuery,
  flowChatsQuery,
} from "../../lib/flow-chat-queries.ts";
import { useFlowRefresh } from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { MadePane } from "./chat-made.tsx";
import { DoneSteps, LiveSteps } from "./chat-steps.tsx";
import { ChatMarkdown } from "./markdown.tsx";
import { PageHeader } from "./parts.tsx";

const failed = (e: unknown, fallback: string) =>
  e instanceof OpError || e instanceof Error ? e.message : fallback;

/** What an empty chat suggests: thinking a feature through, a workflow, a plugin. */
const EXAMPLES = [
  "Let's think through search across notes, then turn it into items",
  "Set up a workflow where I write a brief, an agent drafts and I review",
  "Build a plugin that posts to Slack when an item ships",
];

/** The last model and effort chosen: a new chat starts with them. Per Mac, a convenience. */
const LAST_CHOICE = "flow.chat.choice";
type Pick2 = { model?: string; effort?: string };
function lastChoice(): Pick2 {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(LAST_CHOICE) ?? "{}") as Pick2;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function rememberChoice(choice: Pick2): void {
  try {
    globalThis.localStorage?.setItem(LAST_CHOICE, JSON.stringify(choice));
  } catch {
    // A blocked store only loses the default for the next chat.
  }
}

/**
 * Starts a chat with `text` (and the model and effort chosen, else the last chosen). Answers the new
 * chat's id, with its view already in the cache.
 */
export function useStartChat(orgId: string) {
  const client = useQueryClient();
  const refresh = useFlowRefresh(orgId);
  return async (text: string, choice: Pick2 = lastChoice()): Promise<string> => {
    const view = await op(
      "flow.chat.create",
      {
        orgId,
        text,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
      },
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
  const chats = useQuery(flowChatsQuery(orgId));
  const chat = useQuery({ ...flowChatQuery(orgId, chatId ?? ""), enabled: !!chatId });
  const view = chatId ? chat.data : undefined;
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
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <Conversation
          key={chatId ?? "new"}
          orgId={orgId}
          chatId={chatId}
          loading={!!chatId && !chat.data && !chat.error}
          error={chat.error ? failed(chat.error, "Couldn't load this chat") : null}
          view={view}
          onStarted={onOpen}
        />
        {view && madeAnything(view.made) && <MadePane orgId={orgId} view={view} />}
      </div>
    </main>
  );
}

function Conversation({
  orgId,
  chatId,
  loading,
  error,
  view,
  onStarted,
}: {
  orgId: string;
  chatId: string | undefined;
  loading: boolean;
  error: string | null;
  view: FlowChatView | undefined;
  onStarted: (chatId: string) => void;
}) {
  const client = useQueryClient();
  const start = useStartChat(orgId);
  const options = useQuery(flowChatOptionsQuery(orgId));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // The person's pick in this chat, until it is sent: then it is the chat's.
  const [picked, setPicked] = useState<Pick2>(() => (chatId ? {} : lastChoice()));
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const turns = view ? chatTurns(view.messages, view.working) : [];
  const working = view?.working ?? false;
  const last = view?.messages.at(-1)?.seq ?? 0;
  const model = picked.model ?? view?.chat.model ?? options.data?.defaultModel ?? null;
  const effort = picked.effort ?? view?.chat.effort ?? options.data?.defaultEffort ?? null;
  // Keep the newest message in view as the conversation grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message or the working state arrives
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [last, working]);

  function pick(change: Pick2) {
    const next = { ...picked, ...change };
    setPicked(next);
    rememberChoice({ ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...change });
  }

  async function send() {
    const said = text.trim();
    if (!said || sending || working) return;
    setSending(true);
    try {
      if (!chatId) {
        onStarted(
          await start(said, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }),
        );
      } else {
        // A changed pick goes with this message and is the chat's from now on.
        const choice = {
          ...(model && model !== view?.chat.model ? { model } : {}),
          ...(effort && effort !== view?.chat.effort ? { effort } : {}),
        };
        const next = await op(
          "flow.chat.send",
          { orgId, chatId, text: said, ...choice },
          { idempotencyKey: submitKey() },
        );
        client.setQueryData(flowChatQuery(orgId, chatId).queryKey, next);
        setPicked({});
        void client.invalidateQueries({ queryKey: flowChatsQuery(orgId).queryKey });
      }
      setText("");
    } catch (e) {
      toast.error(failed(e, "Couldn't send that"));
    } finally {
      setSending(false);
    }
  }

  const label = choiceLabel(options.data?.models, view?.chat.model ?? null);
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-panel" data-testid="chat">
      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5" data-testid="chat-messages">
          {error ? (
            <p className="text-bad">{error}</p>
          ) : loading ? (
            <Skeleton className="h-16 w-full" />
          ) : turns.length === 0 ? (
            <Empty
              onExample={(example) => {
                setText(example);
                input.current?.focus();
              }}
            />
          ) : (
            turns.map((t) => (
              <Turn
                key={t.kind === "assistant" && t.runId ? t.runId : `${t.kind}-${t.seq}`}
                orgId={orgId}
                turn={t}
                label={
                  t.kind === "assistant" && t.text !== null
                    ? choiceLabel(options.data?.models, t.model)
                    : label
                }
              />
            ))
          )}
          {view?.truncated && (
            <p className="text-center text-[12px] text-ink-faint">Older messages aren't shown.</p>
          )}
          <div ref={end} />
        </div>
      </div>
      <form
        className="mx-auto mb-4.5 w-[calc(100%-48px)] max-w-[760px] rounded-xl border border-line bg-panel px-3 pt-2 pb-1.5 focus-within:border-line-strong"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        data-testid="chat-box"
      >
        <Textarea
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={working ? "Answering your last message…" : "Message"}
          aria-label="Message"
          className="max-h-40 min-h-8 resize-none border-0 bg-transparent px-0.5 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          data-testid="chat-input"
        />
        <div className="flex items-center justify-end gap-1">
          {options.data && (
            <Pickers
              options={options.data}
              model={model}
              effort={effort}
              onModel={(m) => pick({ model: m })}
              onEffort={(e) => pick({ effort: e })}
            />
          )}
          <Button
            type="submit"
            size="icon-sm"
            className="ml-1 size-7"
            disabled={!text.trim() || sending || working}
            aria-label="Send"
            data-testid="chat-send"
          >
            {sending ? <LoaderIcon className="animate-spin" /> : <ArrowUpIcon />}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Empty({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="mt-[14vh] grid justify-items-center gap-4" data-testid="chat-empty">
      <p className="m-0 text-[18px] text-ink">What would you like to talk about?</p>
      <div className="flex flex-wrap justify-center gap-2">
        {EXAMPLES.map((example) => (
          <Button
            key={example}
            type="button"
            variant="outline"
            size="md"
            className="h-auto max-w-[240px] whitespace-normal py-1.5 text-left font-normal text-ink-muted"
            onClick={() => onExample(example)}
            data-testid="chat-example"
          >
            {example}
          </Button>
        ))}
      </div>
    </div>
  );
}

const trigger =
  "h-7 gap-1 border-0 bg-transparent px-2 text-[12px] text-ink-muted shadow-none hover:bg-hover dark:bg-transparent dark:hover:bg-hover";

function Pickers({
  options,
  model,
  effort,
  onModel,
  onEffort,
}: {
  options: FlowChatOptions;
  model: string | null;
  effort: string | null;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
}) {
  return (
    <>
      <Select value={model ?? undefined} onValueChange={onModel}>
        <SelectTrigger size="sm" className={trigger} aria-label="Model" data-testid="chat-model">
          <SelectValue placeholder="Default" />
        </SelectTrigger>
        <SelectContent align="end">
          {options.models.map((m) => (
            <SelectItem key={m.id} value={m.id} data-testid="chat-model-option">
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={effort ?? undefined} onValueChange={onEffort}>
        <SelectTrigger size="sm" className={trigger} aria-label="Effort" data-testid="chat-effort">
          <SelectValue placeholder="Effort" />
        </SelectTrigger>
        <SelectContent align="end">
          {options.efforts.map((e) => (
            <SelectItem key={e.id} value={e.id} data-testid="chat-effort-option">
              {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

function Turn({ orgId, turn, label }: { orgId: string; turn: ChatTurn; label: string }) {
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
  // What it is doing (or did, folded) first, then the reply, then each thing it changed.
  return (
    <div className="min-w-0" data-testid="chat-assistant-turn">
      <div className="mb-1 text-[12px] text-ink-faint" data-testid="chat-model-label">
        {label}
      </div>
      {turn.runId &&
        (turn.working ? (
          <LiveSteps orgId={orgId} runId={turn.runId} />
        ) : (
          <DoneSteps orgId={orgId} runId={turn.runId} acted={turn.dids.length > 0} />
        ))}
      {turn.working && !turn.runId && (
        <p
          className="m-0 mt-1 flex items-center gap-2 text-[12.5px] text-ink-faint"
          data-testid="chat-working"
        >
          <LoaderIcon className="size-3.5 animate-spin" />
          Thinking…
        </p>
      )}
      {turn.text !== null &&
        (turn.failed ? (
          <p className="m-0 mt-1 whitespace-pre-wrap text-bad" data-testid="chat-failed">
            <CircleAlertIcon className="-mt-0.5 mr-1.5 inline size-4" />
            {turn.text}
          </p>
        ) : (
          <div className="mt-1" data-testid="chat-reply">
            <ChatMarkdown text={turn.text} />
          </div>
        ))}
      {turn.dids.length > 0 && (
        <div className="mt-2.5 grid gap-1.5">
          {turn.dids.map((d) => (
            <div
              key={d.seq}
              className="flex items-center gap-2 rounded-[9px] border border-line px-3 py-2 text-[12.5px]"
              data-testid="chat-did"
            >
              <CircleCheckIcon className="size-4 flex-none text-ok" />
              <span className="truncate">{d.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
