// A flow run as the run view shows it (.kim/mockups/run.html): `flow.run.get`'s totals and
// `flow.run.events`' stored events, typed by hand from @software-factory/store (types only), and the
// pure logic the view needs: tool calls paired with their results into steps, each step's time from
// the run's start, the time bar's segments, and the words for durations, cost and status.

export type FlowRunStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

/** `flow.run.get`'s run: the run, what it ran on, and its totals. */
export interface FlowRunView {
  id: string;
  orgId: string;
  /** Null for a run that belongs to a chat, not an item. */
  itemId: string | null;
  agentId: string;
  statusId: string;
  stay: number;
  brief: string;
  status: FlowRunStatus;
  runnerId: string | null;
  result: { outcome: "done" | "rejected"; summary: string } | null;
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  itemTitle: string | null;
  /** A chat's run: the chat's title (the item fields null). */
  chatTitle?: string | null;
  itemNumber: number | null;
  projectId: string | null;
  projectKey: string | null;
  agentName: string | null;
  statusName: string | null;
  /** "entering Build" for an item's run; null otherwise. */
  startedBy: string | null;
  /** Claimed to finished; null while it runs or if it was never claimed. */
  durationMs: number | null;
  /** Tool calls stored. */
  steps: number;
  /** Null: no runner reports cost today. */
  costUsd: number | null;
  tokens: number | null;
  runnerName: string | null;
  /** It had more than the 2,000 events the engine keeps. */
  eventsTruncated: boolean;
  /** Its events were removed 30 days after it finished. */
  eventsRemoved: boolean;
}

/** One stored event of a run, in seq order; `at` is the runner's clock. */
export type FlowRunEvent =
  | { seq: number; at: string; kind: "note"; text: string }
  | {
      seq: number;
      at: string;
      kind: "tool";
      name: string;
      label: string;
      input: string;
      toolId: string | null;
    }
  | {
      seq: number;
      at: string;
      kind: "result";
      toolId: string;
      output: string;
      isError: boolean;
    };

export interface FlowRunEvents {
  events: FlowRunEvent[];
  truncated: boolean;
  /** The run is no longer queued or claimed. */
  done: boolean;
}

/** The most events `flow.run.events` returns at once: a full page means there may be more. */
export const RUN_EVENTS_PAGE = 500;

/** One row of the step list: what the agent said, or a tool call with its result. */
export type RunStep =
  | { kind: "note"; seq: number; at: number; text: string }
  | {
      kind: "tool";
      seq: number;
      at: number;
      name: string;
      label: string;
      input: string;
      /** Null until its result came (and always for a runner that sends no results). */
      output: string | null;
      isError: boolean;
      /** When its result came; null when unknown. */
      endAt: number | null;
    };

/** The events as steps: each tool call joined by its result (by `toolId`), in order. */
export function runSteps(events: FlowRunEvent[]): RunStep[] {
  const steps: RunStep[] = [];
  const open = new Map<string, Extract<RunStep, { kind: "tool" }>>();
  for (const e of events) {
    const at = Date.parse(e.at);
    if (e.kind === "note") steps.push({ kind: "note", seq: e.seq, at, text: e.text });
    else if (e.kind === "tool") {
      const step: Extract<RunStep, { kind: "tool" }> = {
        kind: "tool",
        seq: e.seq,
        at,
        name: e.name,
        label: e.label,
        input: e.input,
        output: null,
        isError: false,
        endAt: null,
      };
      steps.push(step);
      if (e.toolId) open.set(e.toolId, step);
    } else {
      const step = open.get(e.toolId);
      if (!step) continue;
      step.output = e.output;
      step.isError = e.isError;
      step.endAt = at;
      open.delete(e.toolId);
    }
  }
  return steps;
}

/** A step's time in ms: a tool call's, call to result; null when its result is unknown. */
export const stepMs = (step: RunStep): number | null =>
  step.kind === "tool" && step.endAt !== null ? Math.max(0, step.endAt - step.at) : null;

/** When the run started (claimed, else its first event, else created) and ended (or now). */
export function runSpan(
  run: Pick<FlowRunView, "createdAt" | "claimedAt" | "finishedAt">,
  steps: RunStep[],
  now = Date.now(),
): { start: number; end: number } {
  const first = steps[0]?.at;
  const start = run.claimedAt
    ? Date.parse(run.claimedAt)
    : first !== undefined
      ? first
      : Date.parse(run.createdAt);
  const last = steps.reduce((m, s) => Math.max(m, s.kind === "tool" ? (s.endAt ?? s.at) : s.at), 0);
  const end = run.finishedAt ? Math.max(Date.parse(run.finishedAt), last) : Math.max(now, last);
  return { start, end: Math.max(end, start) };
}

/** A segment of the time bar, as percents of the run's span. */
export interface BarSegment {
  left: number;
  width: number;
  /** `say`: model time that ended in a note; `think`: other model time; `tool`: a tool ran. */
  tone: "say" | "think" | "tool";
}

/**
 * The time bar's two tracks, laid out by the events' timestamps: model time is the gaps between
 * tool calls (from the start, or the last result, to the next call, and on to the end); tool time is
 * each call to its result. A tool whose result is unknown takes no tool time.
 */
export function timeBar(
  steps: RunStep[],
  span: { start: number; end: number },
): { model: BarSegment[]; tools: BarSegment[] } {
  const total = Math.max(1, span.end - span.start);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - span.start) / total) * 100));
  const model: BarSegment[] = [];
  const tools: BarSegment[] = [];
  let cursor = span.start;
  let said = false;
  const think = (to: number) => {
    if (to > cursor) {
      const left = pct(cursor);
      model.push({ left, width: pct(to) - left, tone: said ? "say" : "think" });
    }
    said = false;
  };
  for (const s of steps) {
    if (s.kind === "note") {
      said = true;
      continue;
    }
    think(s.at);
    const end = s.endAt ?? s.at;
    if (s.endAt !== null) {
      const left = pct(s.at);
      tools.push({ left, width: Math.max(0.4, pct(end) - left), tone: "tool" });
    }
    cursor = Math.max(cursor, end);
  }
  think(span.end);
  return { model, tools };
}

/** "15m 3s", "42s", "1h 4m". */
export function runDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** A step's own time: "1.6s" under ten seconds, else as runDuration. */
export function stepDuration(ms: number): string {
  return ms < 10_000 ? `${(Math.round(ms / 100) / 10).toFixed(1)}s` : runDuration(ms);
}

/** "+08:15": a step's time from the run's start (hours when it takes one). */
export function sinceStart(at: number, start: number): string {
  const s = Math.max(0, Math.floor((at - start) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `+${h}:${two(m)}:${two(s % 60)}` : `+${two(m)}:${two(s % 60)}`;
}

/** The time bar's axis: four labels from 0 to the whole run, the middle ones rounded. */
export function axisLabels(totalMs: number): string[] {
  const tick = (ms: number) =>
    ms >= 120_000 ? runDuration(Math.round(ms / 60_000) * 60_000) : runDuration(ms);
  return ["0s", tick(totalMs / 3), tick((2 * totalMs) / 3), runDuration(totalMs)];
}

/** "$1.38"; "<$0.01" for less. */
export function runCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** The header's pill for a run's status. */
export function runPill(status: FlowRunStatus): {
  label: string;
  tone: "ok" | "bad" | "work" | "quiet";
} {
  if (status === "done") return { label: "Finished", tone: "ok" };
  if (status === "failed") return { label: "Failed", tone: "bad" };
  if (status === "claimed") return { label: "Running", tone: "work" };
  if (status === "queued") return { label: "Queued", tone: "quiet" };
  return { label: "Cancelled", tone: "quiet" };
}

/** Whether a run may still change: queued or claimed. */
export const runLive = (status: string) => status === "queued" || status === "claimed";

/**
 * The run line under an agent's summary card (board-and-item-panel.html): how long, the cost when
 * known, and its steps. Duration from claimed to finished.
 */
export function runLine(run: {
  claimedAt: string | null;
  finishedAt: string | null;
  steps?: number;
  costUsd?: number | null;
}): string[] {
  const parts: string[] = [];
  if (run.claimedAt && run.finishedAt)
    parts.push(runDuration(Date.parse(run.finishedAt) - Date.parse(run.claimedAt)));
  if (typeof run.costUsd === "number") parts.push(runCost(run.costUsd));
  if (typeof run.steps === "number") parts.push(`${run.steps} step${run.steps === 1 ? "" : "s"}`);
  return parts;
}

/**
 * A tool call's input as the detail shows it: a Bash call's command, else the JSON indented; text
 * that isn't JSON (a clipped input) as it came.
 */
export function stepInput(name: string, input: string): string {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return input;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (name === "Bash" && typeof o.command === "string") return o.command;
    if (Object.keys(o).length === 0) return "";
  }
  return JSON.stringify(value, null, 2);
}

/**
 * The events after `after`, pages of RUN_EVENTS_PAGE asked for until a short one, appended to
 * `known` (any already known by seq are skipped).
 */
export async function readNewEvents(
  read: (after: number | undefined) => Promise<FlowRunEvents>,
  known: FlowRunEvent[],
): Promise<FlowRunEvents & { events: FlowRunEvent[] }> {
  let events = known;
  let after = known.at(-1)?.seq;
  for (;;) {
    const page = await read(after);
    const fresh = page.events.filter((e) => after === undefined || e.seq > after);
    events = fresh.length ? [...events, ...fresh] : events;
    after = events.at(-1)?.seq ?? after;
    if (page.events.length < RUN_EVENTS_PAGE || fresh.length === 0)
      return { events, truncated: page.truncated, done: page.done };
  }
}
