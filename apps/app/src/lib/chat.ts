// The Chat view's logic (spec 37, ADR 0450), pure: a stream session's events and the messages
// people sent it, as a conversation. Assistant text, tool calls paired with their results, a line
// per turn with its tokens and time, status changes, and the takeover command.
import { shortInput } from "./live.ts";
import type { LiveEvent, LiveSteer } from "./ops.ts";

export interface TurnUsageView {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ChatItem =
  | { kind: "assistant"; key: string; at: string; text: string }
  | {
      kind: "tool";
      key: string;
      at: string;
      name: string;
      /** One short line (the path, the command). */
      summary: string | null;
      /** The whole input, pretty-printed when it is JSON. */
      input: string | null;
      output: string | null;
      isError: boolean;
      /** Waiting for its result. */
      pending: boolean;
    }
  | {
      kind: "turn";
      key: string;
      at: string;
      outcome: "success" | "error";
      durationMs: number | null;
      usage: TurnUsageView | null;
      error: string | null;
    }
  | {
      kind: "status";
      key: string;
      at: string;
      text: string;
      tone: "running" | "waiting" | "failed" | "done";
    }
  | { kind: "takeover"; key: string; at: string; hint: string }
  | { kind: "person"; key: string; at: string; steer: LiveSteer };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function pretty(input: string | null): string | null {
  if (!input) return null;
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

function usageOf(v: unknown): TurnUsageView | null {
  if (!v || typeof v !== "object") return null;
  const u = v as Record<string, unknown>;
  return {
    inputTokens: num(u.inputTokens) ?? 0,
    outputTokens: num(u.outputTokens) ?? 0,
    cacheReadTokens: num(u.cacheReadTokens) ?? 0,
    cacheWriteTokens: num(u.cacheWriteTokens) ?? 0,
  };
}

const STATUS: Record<string, { text: string; tone: "running" | "waiting" | "failed" | "done" }> = {
  idle: { text: "Idle", tone: "waiting" },
  waiting_input: { text: "Waiting for input", tone: "waiting" },
  error: { text: "Error", tone: "failed" },
};

/**
 * The conversation, in time order. `working` and `done` statuses are left out (the turns say as
 * much); a tool call carries its result once it has come.
 */
export function chatItems(events: LiveEvent[], steers: LiveSteer[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  for (const e of events) {
    const key = `e${e.seq}`;
    if (e.type === "message" && e.data.role === "assistant") {
      const text = str(e.data.text);
      if (text) items.push({ kind: "assistant", key, at: e.at, text });
    } else if (e.type === "tool") {
      const input = str(e.data.input);
      const item: Extract<ChatItem, { kind: "tool" }> = {
        kind: "tool",
        key,
        at: e.at,
        name: str(e.data.name) || "tool",
        summary: shortInput(input),
        input: pretty(input),
        output: null,
        isError: false,
        pending: !!str(e.data.id),
      };
      const id = str(e.data.id);
      if (id) tools.set(id, item);
      items.push(item);
    } else if (e.type === "tool.result") {
      const call = tools.get(str(e.data.toolId) ?? "");
      if (call) {
        call.output = str(e.data.output) ?? "";
        call.isError = e.data.isError === true;
        call.pending = false;
      }
    } else if (e.type === "turn") {
      items.push({
        kind: "turn",
        key,
        at: e.at,
        outcome: e.data.outcome === "error" ? "error" : "success",
        durationMs: num(e.data.durationMs),
        usage: usageOf(e.data.usage),
        error: str(e.data.error),
      });
    } else if (e.type === "agent.status") {
      const s = STATUS[str(e.data.status) ?? ""];
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
      const hint = str(e.data.hint);
      if (hint) items.push({ kind: "takeover", key, at: e.at, hint });
    } else if (e.type === "session.ended") {
      const outcome = str(e.data.outcome) ?? "ended";
      items.push({
        kind: "status",
        key,
        at: e.at,
        text: `Session ${outcome.replace("_", " ")}`,
        tone: outcome === "completed" ? "done" : "failed",
      });
    }
  }
  for (const s of steers) {
    if (s.kind === "takeover") {
      items.push({
        kind: "status",
        key: `s${s.id}`,
        at: s.at,
        text: s.status === "delivered" ? "Takeover asked: stopping the session" : "Takeover asked",
        tone: "waiting",
      });
    } else {
      items.push({ kind: "person", key: `s${s.id}`, at: s.at, steer: s });
    }
  }
  return items
    .map((item, i) => ({ item, i, t: Date.parse(item.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.item);
}

/** The resume command, once the session has been handed over (the newest `takeover` event). */
export function takeoverHint(events: LiveEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "takeover") return str(e.data.hint);
  }
  return null;
}

/** Tokens and time for one turn, short: `1.2k in · 340 out · 12.4k cached · 8 s`. */
export function turnLine(item: Extract<ChatItem, { kind: "turn" }>): string {
  const k = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
  const parts: string[] = [];
  if (item.usage) {
    parts.push(`${k(item.usage.inputTokens)} in`, `${k(item.usage.outputTokens)} out`);
    const cached = item.usage.cacheReadTokens + item.usage.cacheWriteTokens;
    if (cached) parts.push(`${k(cached)} cached`);
  }
  if (item.durationMs !== null) {
    const s = item.durationMs / 1000;
    parts.push(s < 60 ? `${s < 10 ? s.toFixed(1) : Math.round(s)} s` : `${Math.round(s / 60)} min`);
  }
  return parts.join(" · ");
}
