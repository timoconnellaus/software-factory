// The Live tab's logic (spec 31, ADR 0400), pure: folding polled `run.live` answers into one view,
// and turning a run's events into the transcript and the terminal.
import type { LiveEvent, LiveSteer, LiveView } from "./ops.ts";

/** Most events the browser keeps for one run (older ones drop off the top). */
export const KEEP_EVENTS = 2_000;

/**
 * The view after a poll. `next` answered `afterSeq: prev.lastSeq` for the same run, so its events
 * are new; a different run (or no previous view) starts over.
 */
export function mergeLive(prev: LiveView | undefined, next: LiveView): LiveView {
  if (!prev?.run || !next.run || prev.run.id !== next.run.id) return next;
  const seen = new Set(prev.events.map((e) => e.seq));
  const events = [...prev.events, ...next.events.filter((e) => !seen.has(e.seq))];
  return {
    ...next,
    events: events.slice(-KEEP_EVENTS),
    truncated: prev.truncated || events.length > KEEP_EVENTS,
    lastSeq: Math.max(prev.lastSeq, next.lastSeq),
  };
}

export type TranscriptItem =
  | { kind: "message"; key: string; at: string; text: string }
  | { kind: "tool"; key: string; at: string; name: string; input: string | null }
  | {
      kind: "status";
      key: string;
      at: string;
      text: string;
      tone: "running" | "waiting" | "failed" | "done";
    }
  | { kind: "steer"; key: string; at: string; steer: LiveSteer };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A tool call's input as one short line: the path, the command or the pattern when there is one. */
export function shortInput(input: string | null, max = 120): string | null {
  if (!input) return null;
  let text = input;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      text =
        str(parsed.command) ??
        str(parsed.file_path) ??
        str(parsed.path) ??
        str(parsed.pattern) ??
        str(parsed.url) ??
        str(parsed.description) ??
        input;
    }
  } catch {
    // Not JSON (clipped): show it as it is.
  }
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const STATUS_TEXT: Record<
  string,
  { text: string; tone: "running" | "waiting" | "failed" | "done" }
> = {
  working: { text: "Working", tone: "running" },
  idle: { text: "Idle, waiting for news", tone: "waiting" },
  waiting_input: { text: "Waiting for input", tone: "waiting" },
  done: { text: "Done", tone: "done" },
  error: { text: "Error", tone: "failed" },
};

const OUTCOME_TONE: Record<string, "done" | "failed"> = { completed: "done" };

/**
 * The transcript: what the agent said, the tools it called, its status changes and the session's
 * end, with the steers people sent, in time order.
 */
export function transcriptItems(events: LiveEvent[], steers: LiveSteer[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const e of events) {
    const key = `e${e.seq}`;
    if (e.type === "message" && e.data.role === "assistant") {
      const text = str(e.data.text);
      if (text) items.push({ kind: "message", key, at: e.at, text });
    } else if (e.type === "tool") {
      items.push({
        kind: "tool",
        key,
        at: e.at,
        name: str(e.data.name) || "tool",
        input: shortInput(str(e.data.input)),
      });
    } else if (e.type === "agent.status") {
      const s = STATUS_TEXT[str(e.data.status) ?? ""];
      if (!s) continue;
      const message = str(e.data.message);
      items.push({
        kind: "status",
        key,
        at: e.at,
        text: message ? `${s.text}: ${message}` : s.text,
        tone: s.tone,
      });
    } else if (e.type === "takeover") {
      items.push({
        kind: "status",
        key,
        at: e.at,
        text: "Handed over: resume it in a terminal",
        tone: "waiting",
      });
    } else if (e.type === "session.started") {
      items.push({ kind: "status", key, at: e.at, text: "Session started", tone: "running" });
    } else if (e.type === "session.ended") {
      const outcome = str(e.data.outcome) ?? "ended";
      items.push({
        kind: "status",
        key,
        at: e.at,
        text: `Session ${outcome.replace("_", " ")}`,
        tone: OUTCOME_TONE[outcome] ?? "failed",
      });
    }
  }
  for (const s of steers) {
    // A takeover request (ADR 0450) has no text: shown as a status line.
    if (s.kind === "takeover") {
      items.push({
        kind: "status",
        key: `s${s.id}`,
        at: s.at,
        text: "Takeover asked",
        tone: "waiting",
      });
    } else {
      items.push({ kind: "steer", key: `s${s.id}`, at: s.at, steer: s });
    }
  }
  // Stable: events keep their seq order; a steer goes after the events of the same instant.
  return items
    .map((item, i) => ({ item, i, t: Date.parse(item.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.item);
}

/**
 * The terminal: the lines that scrolled off, oldest first, then the latest screen. Claude's TUI
 * redraws in place, so only the newest screen is worth showing.
 */
export function terminalText(events: LiveEvent[], maxChars = 120_000): string {
  const scrolled: string[] = [];
  let screen: string | null = null;
  for (const e of events) {
    if (e.type !== "log") continue;
    const text = str(e.data.text);
    if (!text) continue;
    if (e.data.screen === true) screen = text;
    else scrolled.push(text.replace(/\n+$/, ""));
  }
  const parts = [...scrolled];
  if (screen) parts.push(screen.replace(/\n+$/, ""));
  const all = parts.join("\n");
  return all.length > maxChars ? `…\n${all.slice(-maxChars)}` : all;
}

/** The agent's latest status, for the header line. */
export function latestStatus(events: LiveEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "agent.status") return STATUS_TEXT[str(e.data.status) ?? ""]?.text ?? null;
    if (e?.type === "session.ended") return "Ended";
  }
  return null;
}
