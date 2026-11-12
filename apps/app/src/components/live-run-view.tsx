// The Live tab's view (spec 31, ADR 0400; mockup live-run): a run as it goes. Transcript (what the
// agent says, the tools it calls, status changes, the messages people sent) and Terminal
// (scrolled-off lines, then the latest screen). The runner's owner gets a message box; everyone
// else watches read-only. Pure presentation: `live-run.tsx` polls and sends.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LiveChat } from "#/components/live-chat";
import { capitalise, clock, errorMessage } from "#/lib/format";
import { latestStatus, type TranscriptItem, terminalText, transcriptItems } from "#/lib/live";
import type { LiveView } from "#/lib/ops";

export type View = "chat" | "transcript" | "terminal";

/** The live view itself, from a `run.live` answer (rendered on its own in tests). */
export function LiveRunView({
  data,
  me,
  onSteer,
  onTakeover = async () => {},
  initialView,
}: {
  data: LiveView;
  me: string;
  /** Sends a message into the run (the runner's owner only; the operation checks). */
  onSteer: (runId: string, text: string) => Promise<void>;
  /** Asks to take a stream session over in a terminal (spec 37; the owner only). */
  onTakeover?: (runId: string) => Promise<void>;
  initialView?: View;
}) {
  // A stream session (spec 37) is shown as a chat by default; a terminal one as its transcript.
  const chat = data.run?.mode === "stream";
  const [picked, setView] = useState<View | null>(initialView ?? null);
  const view: View = picked ?? (chat ? "chat" : "transcript");
  const { run, events, steers, steer } = data;
  if (!run) {
    return <Card className="px-5 py-6 text-muted-foreground text-sm">No runs yet.</Card>;
  }
  const status = latestStatus(events);
  return (
    <Card className="gap-3 px-5 py-4" data-testid="live-run">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusDot
          status={
            run.active
              ? "running"
              : run.outcome === "completed" || run.status === "handed_back"
                ? "done"
                : "failed"
          }
        />
        <span className="font-medium">
          Run #{run.runNo} · {capitalise(run.stage)}
        </span>
        <span className="font-mono text-muted-foreground text-xs">
          {run.runnerName ?? run.runnerId} · Claude Code
        </span>
        {status && <span className="text-muted-foreground text-xs">· {status}</span>}
        {!run.active && (
          <span className="text-muted-foreground text-xs">· {run.outcome ?? run.status}</span>
        )}
        <span className="grow" />
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          onValueChange={(v) => v && setView(v as View)}
          aria-label="Live view"
        >
          {chat && (
            <ToggleGroupItem value="chat" data-testid="live-chat-tab">
              Chat
            </ToggleGroupItem>
          )}
          <ToggleGroupItem value="transcript" data-testid="live-transcript-tab">
            Transcript
          </ToggleGroupItem>
          <ToggleGroupItem value="terminal" data-testid="live-terminal-tab">
            Terminal
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {view === "chat" && chat ? (
        // The chat has its own composer and takeover (spec 37).
        <LiveChat data={data} me={me} onSteer={onSteer} onTakeover={onTakeover} />
      ) : view === "terminal" ? (
        <Terminal text={terminalText(events)} />
      ) : (
        <Transcript items={transcriptItems(events, steers)} me={me} truncated={data.truncated} />
      )}
      {!(view === "chat" && chat) &&
        run.active &&
        (steer.allowed ? (
          <SteerBox onSteer={(text) => onSteer(run.id, text)} max={steer.max} />
        ) : (
          <div className="text-muted-foreground text-xs" data-testid="steer-readonly">
            Watching read-only. {steer.reason}
          </div>
        ))}
    </Card>
  );
}

/** Keeps a scrolled-to-the-bottom pane at the bottom as it grows. */
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

const PANE =
  "h-[420px] overflow-auto rounded-lg bg-zinc-950 p-3.5 font-mono text-xs text-zinc-200 leading-relaxed";

function Transcript({
  items,
  me,
  truncated,
}: {
  items: TranscriptItem[];
  me: string;
  truncated: boolean;
}) {
  const { ref, onScroll } = useStickToBottom(items.length);
  return (
    <div ref={ref} onScroll={onScroll} className={PANE} data-testid="live-stream">
      {truncated && <div className="text-zinc-500">… earlier events not shown</div>}
      {items.length === 0 && <div className="text-zinc-500">Nothing yet: the run is starting.</div>}
      {items.map((item) => (
        <TranscriptRow key={item.key} item={item} me={me} />
      ))}
    </div>
  );
}

const TONE: Record<string, string> = {
  running: "text-sky-400",
  waiting: "text-amber-400",
  failed: "text-red-400",
  done: "text-green-500",
};

function TranscriptRow({ item, me }: { item: TranscriptItem; me: string }) {
  const time = <span className="mr-2 text-zinc-600">{clock(item.at)}</span>;
  switch (item.kind) {
    case "message":
      return (
        <div className="my-1.5 whitespace-pre-wrap font-sans text-[13px] text-zinc-100">
          {time}
          {item.text}
        </div>
      );
    case "tool":
      return (
        <div className="truncate" title={item.input ?? undefined}>
          {time}● <span className="text-zinc-100">{item.name}</span>
          {item.input && <span className="text-zinc-400"> {item.input}</span>}
        </div>
      );
    case "status":
      return (
        <div className={TONE[item.tone]}>
          {time}▸ {item.text}
        </div>
      );
    case "steer": {
      const s = item.steer;
      const who = s.authorUserId === me ? "You" : (s.authorName ?? "Someone");
      return (
        <div
          className="my-1.5 whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-sans text-[13px]"
          data-testid="live-steer"
        >
          {time}
          <span className="font-medium text-zinc-100">{who}</span>
          <span
            className={cn(
              "ml-2 text-[11px]",
              s.status === "delivered"
                ? "text-green-500"
                : s.status === "queued"
                  ? "text-amber-400"
                  : "text-red-400",
            )}
          >
            {s.status === "delivered"
              ? "sent to the agent"
              : s.status === "queued"
                ? "sending…"
                : "not delivered: the run ended"}
          </span>
          <div className="text-zinc-200">{s.text}</div>
        </div>
      );
    }
  }
}

function Terminal({ text }: { text: string }) {
  const { ref, onScroll } = useStickToBottom(text.length);
  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={cn(PANE, "whitespace-pre")}
      data-testid="live-terminal"
    >
      {text || <span className="text-zinc-500">No terminal output yet.</span>}
    </div>
  );
}

function SteerBox({ onSteer, max }: { onSteer: (text: string) => Promise<void>; max: number }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(event: React.FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    setBusy(true);
    try {
      await onSteer(message);
      setText("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flex gap-2" onSubmit={send} data-testid="steer-form">
      <Input
        value={text}
        maxLength={max}
        onChange={(e) => setText(e.target.value)}
        placeholder="Message the agent… (it sees this at its next step)"
        aria-label="Message the agent"
        disabled={busy}
      />
      <Button type="submit" disabled={busy || !text.trim()}>
        Send
      </Button>
    </form>
  );
}
