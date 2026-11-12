// The Live tab's Chat view (spec 37, ADR 0450): a stream-json run as a conversation. Assistant
// text as Markdown, each tool call collapsible with its input and output, a line per turn with
// tokens and time, status changes, and the runner owner's messages as their bubbles. The owner
// gets a composer and "Take over in a terminal"; everyone else watches. Pure presentation:
// `live-run.tsx` polls and sends.

import { clock, errorMessage } from "@software-factory/client/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@software-factory/ui/components/alert-dialog";
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { type ChatItem, chatItems, takeoverHint, turnLine } from "#/lib/chat";
import type { LiveView } from "#/lib/ops";

const MARKDOWN =
  "text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_li]:ml-4 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre_code]:bg-transparent [&_pre_code]:p-0";

/** The Chat view of a stream session (rendered inside the Live tab's card). */
export function LiveChat({
  data,
  me,
  onSteer,
  onTakeover,
}: {
  data: LiveView;
  me: string;
  onSteer: (runId: string, text: string) => Promise<void>;
  onTakeover: (runId: string) => Promise<void>;
}) {
  const { run, events, steers, steer, takeover } = data;
  const items = chatItems(events, steers);
  // Once handed over, the command to resume it (useful only while the run still holds it).
  const hint = run?.active ? takeoverHint(events) : null;
  if (!run) return null;
  return (
    <div className="grid gap-3" data-testid="live-chat">
      <Conversation items={items} me={me} truncated={data.truncated} />
      {hint && <TakeoverCommand hint={hint} />}
      {run.active && !hint && takeover.requested && (
        <div className="text-muted-foreground text-xs" data-testid="takeover-pending">
          Stopping the session for you… the command to resume it appears here.
        </div>
      )}
      {run.active &&
        !takeover.requested &&
        (steer.allowed ? (
          <Composer
            max={steer.max}
            onSend={(text) => onSteer(run.id, text)}
            {...(takeover.allowed ? { onTakeover: () => onTakeover(run.id) } : {})}
          />
        ) : (
          <div className="text-muted-foreground text-xs" data-testid="chat-readonly">
            Watching read-only. {steer.reason}
          </div>
        ))}
    </div>
  );
}

function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the content changes.
  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

function Conversation({
  items,
  me,
  truncated,
}: {
  items: ChatItem[];
  me: string;
  truncated: boolean;
}) {
  const { ref, onScroll } = useStickToBottom(items.length);
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="grid h-[480px] content-start gap-2.5 overflow-auto rounded-lg border bg-muted/30 p-3.5"
      data-testid="chat-stream"
    >
      {truncated && (
        <div className="text-muted-foreground text-xs">… earlier messages not shown</div>
      )}
      {items.length === 0 && (
        <div className="text-muted-foreground text-sm">Nothing yet: the session is starting.</div>
      )}
      {items.map((item) => (
        <ChatRow key={item.key} item={item} me={me} />
      ))}
    </div>
  );
}

const TONE = { running: "running", waiting: "waiting", failed: "failed", done: "done" } as const;

function ChatRow({ item, me }: { item: ChatItem; me: string }) {
  const time = (
    <span className="font-mono text-[11px] text-muted-foreground">{clock(item.at)}</span>
  );
  switch (item.kind) {
    case "assistant":
      return (
        <div
          className="max-w-[88%] rounded-lg border bg-card px-3 py-2 shadow-xs"
          data-testid="chat-assistant"
        >
          <div className="mb-0.5 flex items-center gap-2 text-xs">
            <span className="font-medium">Claude</span>
            {time}
          </div>
          <div className={MARKDOWN}>
            <Markdown>{item.text}</Markdown>
          </div>
        </div>
      );
    case "tool":
      return <ToolCall item={item} />;
    case "turn":
      return (
        <div
          className="flex items-center gap-2 text-muted-foreground text-xs"
          data-testid="chat-turn"
        >
          <StatusDot status={item.outcome === "success" ? "done" : "failed"} />
          <span>{item.outcome === "success" ? "Turn done" : "Turn failed"}</span>
          <span className="font-mono">{turnLine(item)}</span>
          {item.error && <span className="truncate text-status-failed">{item.error}</span>}
        </div>
      );
    case "status":
      return (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <StatusDot status={TONE[item.tone]} />
          {item.text}
          {time}
        </div>
      );
    case "takeover":
      return (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <StatusDot status="waiting" />
          Handed over: resume it in a terminal on the runner.
          {time}
        </div>
      );
    case "person": {
      const s = item.steer;
      const who = s.authorUserId === me ? "You" : (s.authorName ?? "Someone");
      return (
        <div
          className="ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-primary-foreground"
          data-testid="chat-person"
        >
          <div className="mb-0.5 flex items-center gap-2 text-xs opacity-80">
            <span className="font-medium">{who}</span>
            <span className="font-mono text-[11px]">{clock(s.at)}</span>
            <span>
              {s.status === "delivered"
                ? "· sent to the agent"
                : s.status === "queued"
                  ? "· sending…"
                  : "· not delivered: the run ended"}
            </span>
          </div>
          <div className="whitespace-pre-wrap text-sm">{s.text}</div>
        </div>
      );
    }
  }
}

function ToolCall({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  return (
    <Collapsible className="max-w-[88%] rounded-md border bg-card text-xs" data-testid="chat-tool">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50">
        <StatusDot status={item.pending ? "running" : item.isError ? "failed" : "done"} />
        <span className="font-medium font-mono">{item.name}</span>
        {item.summary && (
          <span className="truncate font-mono text-muted-foreground">{item.summary}</span>
        )}
        <span className="grow" />
        {item.isError && <Badge variant="outline">error</Badge>}
        <span className="text-muted-foreground">▾</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 border-t px-2.5 py-2">
        {item.input && (
          <div>
            <div className="mb-1 text-muted-foreground">Input</div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono">
              {item.input}
            </pre>
          </div>
        )}
        <div>
          <div className="mb-1 text-muted-foreground">Output</div>
          <pre
            className={cn(
              "max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono",
              item.isError && "text-status-failed",
            )}
          >
            {item.pending ? "running…" : item.output || "(no output)"}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Composer({
  max,
  onSend,
  onTakeover,
}: {
  max: number;
  onSend: (text: string) => Promise<void>;
  onTakeover?: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    try {
      await onSend(message);
      setText("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function takeOver() {
    if (!onTakeover) return;
    setBusy(true);
    try {
      await onTakeover();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="grid gap-2"
      data-testid="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Textarea
        value={text}
        maxLength={max}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Message the agent… (Enter sends, Shift+Enter for a new line)"
        aria-label="Message the agent"
        disabled={busy}
      />
      <div className="flex items-center gap-2">
        {onTakeover && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                data-testid="takeover-button"
              >
                Take over in a terminal
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Take over in a terminal?</AlertDialogTitle>
                <AlertDialogDescription>
                  The agent stops its current step and the session leaves the dashboard. You get a
                  `claude --resume` command to run on the runner, with the run's settings. When you
                  quit it, the run is handed back as usual.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void takeOver()}>
                  Stop and take over
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <span className="grow" />
        <Button type="submit" disabled={busy || !text.trim()}>
          Send
        </Button>
      </div>
    </form>
  );
}

function TakeoverCommand({ hint }: { hint: string }) {
  return (
    <div className="grid gap-1.5 rounded-lg border p-3 text-sm" data-testid="takeover-command">
      <div className="font-medium">Resume it in a terminal on the runner</div>
      <div className="text-muted-foreground text-xs">
        The same conversation, worktree and settings. Quitting it hands the run back.
      </div>
      <div className="flex items-start gap-2">
        <code className="grow overflow-x-auto whitespace-pre rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {hint}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(hint).then(
              () => toast.success("Copied"),
              () => toast.error("Couldn't copy"),
            )
          }
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
