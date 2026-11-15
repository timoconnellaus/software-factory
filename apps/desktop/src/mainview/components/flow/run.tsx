// A run (.kim/mockups/run.html): a large modal over whatever the content panel shows, opened by
// `?run=<id>`. Its header (Finished / Running / Failed, the agent, what it ran on), the summary row,
// the time bar (model time and tool time, laid out by the events' timestamps), and the steps on the
// left with the chosen one's input and result on the right. While the run is in flight its new
// events are read every 3 seconds, and the list keeps to the newest unless the person scrolled up.
// Nothing else: no live socket, no search, no filters, no steering.
import {
  axisLabels,
  type BarSegment,
  type FlowRunEvent,
  type FlowRunView,
  type RunStep,
  readNewEvents,
  runCost,
  runDuration,
  runLive,
  runPill,
  runSpan,
  runSteps,
  sinceStart,
  stepDuration,
  stepInput,
  stepMs,
  timeBar,
} from "@software-factory/client/flow-run";
import { Button } from "@software-factory/ui/components/button";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  MessageSquareIcon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flowRunQuery, RUN_POLL_MS } from "../../lib/flow-queries.ts";
import { read } from "../../lib/op.ts";
import { OwnerMark } from "./parts.tsx";

/** The run modal for `?run=`, over the content panel. Escape or the backdrop closes it. */
export function RunModal({ orgId, runId }: { orgId: string; runId: string }) {
  const navigate = useNavigate();
  const close = () =>
    void navigate({
      to: ".",
      search: (s: Record<string, unknown>) => ({ ...s, run: undefined }),
    } as never);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop's click is a mouse shortcut; Escape and the close button close it too.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the window.
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-[rgba(30,30,28,0.28)] p-[26px] dark:bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      data-testid="run-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Run"
        className="flex h-full max-h-[690px] w-full max-w-[1040px] flex-col overflow-hidden rounded-[14px] border border-line bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.25)] dark:shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        data-testid="run-modal"
      >
        <RunBody key={runId} orgId={orgId} runId={runId} onClose={close} />
      </div>
    </div>
  );
}

/** The run's events: every page on open, then what is new every 3 s while it runs. */
function useRunEvents(orgId: string, runId: string) {
  const [state, setState] = useState<{
    events: FlowRunEvent[];
    truncated: boolean;
    done: boolean;
    loaded: boolean;
    error: string | null;
  }>({ events: [], truncated: false, done: false, loaded: false, error: null });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let known: FlowRunEvent[] = [];
    let polls = 0;
    // After it ends, one more read: the host sends its last events just after its hand-back.
    let lastRound = false;
    const tick = async () => {
      let done = false;
      if (document.visibilityState !== "hidden") {
        try {
          const r = await readNewEvents(
            (after) =>
              read("flow.run.events", { orgId, runId, ...(after !== undefined ? { after } : {}) }),
            known,
          );
          if (stopped) return;
          known = r.events;
          done = r.done;
          setState({ ...r, loaded: true, error: null });
        } catch (error) {
          if (stopped) return;
          setState((s) => ({
            ...s,
            loaded: true,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        polls++;
      }
      if (stopped) return;
      if (done && (polls === 1 || lastRound)) return;
      if (done) lastRound = true;
      timer = setTimeout(tick, RUN_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [orgId, runId]);
  return state;
}

function RunBody({ orgId, runId, onClose }: { orgId: string; runId: string; onClose: () => void }) {
  const got = useQuery(flowRunQuery(orgId, runId));
  const feed = useRunEvents(orgId, runId);
  const run = got.data?.run;
  if (got.error)
    return (
      <>
        <Header run={undefined} onClose={onClose} />
        <p className="p-5 text-bad">Couldn't load this run. {got.error.message}</p>
      </>
    );
  if (!run)
    return (
      <>
        <Header run={undefined} onClose={onClose} />
        <div className="grid gap-3 p-5" aria-busy="true">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      </>
    );
  return <Loaded run={run} feed={feed} onClose={onClose} />;
}

function Loaded({
  run,
  feed,
  onClose,
}: {
  run: FlowRunView;
  feed: ReturnType<typeof useRunEvents>;
  onClose: () => void;
}) {
  const live = runLive(run.status);
  const steps = runSteps(feed.events);
  // While it runs, the clock moves on: the bar and the totals are redrawn with each read.
  const span = runSpan(run, steps);
  const [chosen, setChosen] = useState<number | null>(null);
  const selected =
    steps.find((s) => s.seq === chosen) ??
    // In flight: the newest. Failed: the step that failed. Else the first tool call.
    (live
      ? steps.at(-1)
      : ((run.status === "failed"
          ? steps.findLast((s) => s.kind === "tool" && s.isError)
          : undefined) ??
        steps.find((s) => s.kind === "tool") ??
        steps[0]));
  const took = run.durationMs ?? (live && run.claimedAt ? span.end - span.start : null);

  return (
    <>
      <Header run={run} onClose={onClose} />
      {run.status === "failed" && run.error && (
        <div
          className="whitespace-pre-wrap border-bad/20 border-b bg-bad/5 px-4 py-2.5 text-[12.5px] text-bad"
          data-testid="run-error"
        >
          {run.error}
        </div>
      )}
      <div
        className="flex flex-wrap items-center gap-x-[18px] gap-y-1 border-line-soft border-b px-4 py-[9px] text-[12px] text-ink-muted"
        data-testid="run-summary"
      >
        {run.startedBy && (
          <span>
            Started by <b className="font-medium text-ink">{run.startedBy}</b>
          </span>
        )}
        {took !== null && (
          <span>
            {live ? "Running for" : "Took"}{" "}
            <b className="font-medium text-ink">{runDuration(took)}</b>
          </span>
        )}
        {run.costUsd !== null && (
          <span>
            Cost <b className="font-medium text-ink">{runCost(run.costUsd)}</b>
          </span>
        )}
        {run.runnerName && (
          <span>
            Runner <b className="font-medium text-ink">{run.runnerName}</b>
          </span>
        )}
        <span>
          Steps <b className="font-medium text-ink">{run.steps}</b>
        </span>
        {(run.eventsTruncated || run.eventsRemoved) && (
          <span className="ml-auto text-ink-faint" data-testid="run-cut">
            {run.eventsRemoved
              ? "Its steps were removed 30 days after it finished."
              : "Only its first 2,000 events were kept."}
          </span>
        )}
      </div>
      {steps.length > 0 && <TimeBar steps={steps} span={span} />}
      <div className="flex min-h-0 flex-1">
        <StepList
          steps={steps}
          start={span.start}
          live={live}
          selected={selected?.seq ?? null}
          onSelect={setChosen}
          empty={
            !feed.loaded
              ? null
              : feed.error
                ? `Couldn't load its steps. ${feed.error}`
                : run.eventsRemoved
                  ? "Its steps were removed 30 days after it finished."
                  : live
                    ? "Nothing reported yet."
                    : "The runner reported no steps."
          }
        />
        <div
          className="min-w-0 flex-1 overflow-auto px-4 py-3.5 text-[12px]"
          data-testid="step-detail"
        >
          {selected && <Detail step={selected} start={span.start} live={live} />}
        </div>
      </div>
    </>
  );
}

const PILL = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  bad: "border-bad/30 bg-bad/10 text-bad",
  work: "border-transparent bg-work-soft text-work",
  quiet: "border-line text-ink-muted",
} as const;

function Header({ run, onClose }: { run: FlowRunView | undefined; onClose: () => void }) {
  const pill = run ? runPill(run.status) : null;
  const on =
    run?.itemNumber != null
      ? `${run.projectKey ? `${run.projectKey}-` : "#"}${run.itemNumber} ${run.itemTitle ?? ""}`
      : run?.chatTitle
        ? `the chat "${run.chatTitle}"`
        : null;
  return (
    <div className="flex items-center gap-2.5 border-line-soft border-b px-4 py-3">
      {pill && (
        <span
          className={cn(
            "inline-flex h-[20px] items-center rounded-full border px-2 text-[11.5px]",
            PILL[pill.tone],
          )}
          data-testid="run-status"
        >
          {pill.label}
        </span>
      )}
      {run && (
        <>
          <OwnerMark name={run.agentName ?? "An agent"} kind="agent" />
          <b className="font-semibold text-[14px]" data-testid="run-agent">
            {run.agentName ?? "An agent"}
          </b>
          {on && <span className="min-w-0 truncate text-ink-muted">on {on}</span>}
        </>
      )}
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="icon-md"
        onClick={onClose}
        aria-label="Close run"
        data-testid="close-run"
      >
        <XIcon />
      </Button>
    </div>
  );
}

const SEGMENT: Record<BarSegment["tone"], string> = {
  say: "bg-ok",
  think: "bg-work/40",
  tool: "bg-work",
};

function TimeBar({ steps, span }: { steps: RunStep[]; span: { start: number; end: number } }) {
  const bar = timeBar(steps, span);
  const labels = axisLabels(span.end - span.start);
  const track = (segments: BarSegment[]) => (
    <div className="relative h-3 overflow-hidden rounded-[3px] bg-window">
      {segments.map((s) => (
        <i
          key={`${s.tone}${s.left}`}
          className={cn("absolute top-0 bottom-0 rounded-[2px]", SEGMENT[s.tone])}
          style={{ left: `${s.left}%`, width: `${s.width}%` }}
        />
      ))}
    </div>
  );
  return (
    <div className="border-line-soft border-b px-4 pt-2.5 pb-3" data-testid="time-bar">
      <div className="ml-[92px] flex justify-between text-[10.5px] text-ink-faint">
        {labels.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the axis has four fixed places.
          <span key={i}>{l}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-[92px_1fr] items-center text-[11.5px] text-ink-muted">
        Model
        {track(bar.model)}
      </div>
      <div className="mt-1 grid grid-cols-[92px_1fr] items-center text-[11.5px] text-ink-muted">
        Tools
        {track(bar.tools)}
      </div>
    </div>
  );
}

/** A tool's icon by its name. */
function ToolIcon({ name }: { name: string }) {
  const cls = "mt-0.5 size-3.5 text-ink-muted";
  if (name === "Bash") return <TerminalIcon className={cls} />;
  if (name === "Read") return <FileTextIcon className={cls} />;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return <FilePenIcon className={cls} />;
  if (name === "Grep" || name === "Glob") return <SearchIcon className={cls} />;
  if (name === "WebFetch" || name === "WebSearch") return <GlobeIcon className={cls} />;
  if (name === "Task" || name === "Agent") return <BotIcon className={cls} />;
  if (name.startsWith("mcp__")) return <PlugIcon className={cls} />;
  return <WrenchIcon className={cls} />;
}

function StepList({
  steps,
  start,
  live,
  selected,
  onSelect,
  empty,
}: {
  steps: RunStep[];
  start: number;
  live: boolean;
  selected: number | null;
  onSelect: (seq: number) => void;
  empty: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  // While it runs the list keeps to the newest, until the person scrolls up.
  const stick = useRef(live);
  const count = steps.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls again when steps arrive.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = live && el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="min-w-0 flex-[1.25] overflow-auto border-line-soft border-r"
      data-testid="step-list"
    >
      {steps.length === 0 && empty && <p className="p-4 text-ink-muted">{empty}</p>}
      {steps.map((s) => {
        const ms = stepMs(s);
        return (
          <Button
            key={s.seq}
            variant="ghost"
            // `md`: the window's look fixes the default size's height (desktop.css).
            size="md"
            onClick={() => onSelect(s.seq)}
            aria-pressed={s.seq === selected}
            className={cn(
              "grid h-auto w-full grid-cols-[54px_20px_1fr_44px] items-start justify-normal gap-1.5 whitespace-normal rounded-none border-line-soft border-b px-3.5 py-2 text-left font-normal text-[12.5px] has-[>svg]:px-3.5",
              s.kind === "note" && "bg-board",
              s.seq === selected && "bg-work-soft hover:bg-work-soft dark:hover:bg-work-soft",
            )}
            data-testid={s.kind === "note" ? "run-note" : "run-step"}
          >
            <time className="pt-0.5 font-mono text-[11px] text-ink-faint">
              {sinceStart(s.at, start)}
            </time>
            {s.kind === "note" ? (
              <MessageSquareIcon className="mt-0.5 size-3.5 text-ink-muted" />
            ) : (
              <ToolIcon name={s.name} />
            )}
            {s.kind === "note" ? (
              <span className="line-clamp-4 min-w-0 break-words">{s.text}</span>
            ) : (
              <span className="min-w-0 truncate">
                <b className={cn("font-semibold", s.isError && "text-bad")}>{s.name}</b>{" "}
                <code className="font-mono text-[11.5px] text-ink-muted">{s.label}</code>
              </span>
            )}
            <span className="text-right text-[11.5px] text-ink-faint">
              {ms !== null ? stepDuration(ms) : ""}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

function Detail({ step, start, live }: { step: RunStep; start: number; live: boolean }) {
  const h4 = "mb-1.5 font-semibold text-[10.5px] text-ink-faint tracking-[0.04em]";
  const pre =
    "mb-3.5 whitespace-pre-wrap break-words rounded-lg border border-line-soft bg-board p-2.5 font-mono text-[11.5px] leading-[1.5]";
  const ms = stepMs(step);
  if (step.kind === "note")
    return (
      <>
        <h4 className={h4}>
          <span className="uppercase">The agent</span> · {sinceStart(step.at, start)}
        </h4>
        <p className="whitespace-pre-wrap text-[12.5px]" data-testid="step-note">
          {step.text}
        </p>
      </>
    );
  return (
    <>
      <h4 className={h4}>
        <span className="uppercase">{step.name}</span> · {sinceStart(step.at, start)}
        {ms !== null && ` · ${stepDuration(ms)}`}
      </h4>
      <h4 className={cn(h4, "mt-3")}>INPUT</h4>
      <pre className={pre} data-testid="step-input">
        {stepInput(step.name, step.input) || "(none)"}
      </pre>
      <h4 className={h4}>RESULT</h4>
      {step.output !== null ? (
        <pre className={cn(pre, step.isError && "border-bad/40")} data-testid="step-result">
          {step.output || "(empty)"}
        </pre>
      ) : (
        <p className="text-ink-muted" data-testid="step-no-result">
          {live
            ? "No result yet."
            : "No result reported: this runner sends tool calls without their results."}
        </p>
      )}
    </>
  );
}
