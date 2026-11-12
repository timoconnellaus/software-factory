// Claude Code as a two-way stream-json session (ADR 0450): `claude -p --input-format stream-json
// --output-format stream-json --verbose`. What goes in (a user message, an interrupt, a denied
// permission request) and what comes out (one JSON object per line) turned into the runner
// contract's events, every field bounded. Pure: the adapter (runner-local `stream.ts`) owns the
// process.
import {
  type AdapterEvent,
  MESSAGE_MAX,
  TOOL_OUTPUT_MAX,
  TURN_ERROR_MAX,
  type TurnUsage,
} from "@software-factory/runner-contract";

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
/** Keeps the end of a long output: errors and summaries are at the bottom. */
const clipTail = (text: string, max: number) =>
  text.length > max ? `…${text.slice(text.length - (max - 1))}` : text;

/** Most characters of a tool call's input kept in its `tool` event. */
export const STREAM_TOOL_INPUT_MAX = 7_000;

interface Part {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | { type?: string; text?: string }[];
  is_error?: boolean;
}

/** One line of stream-json output, as far as the factory reads it. */
export interface StreamMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  /** Set on messages a subagent produced (its Task tool call's id). */
  parent_tool_use_id?: string | null;
  message?: { role?: string; content?: string | Part[] };
  // result
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  errors?: unknown[];
  // control
  request_id?: string;
  request?: { subtype?: string; tool_name?: string };
}

/** Parses one output line; null for a line that isn't a JSON object. */
export function parseStreamLine(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as StreamMessage)
      : null;
  } catch {
    return null;
  }
}

function resultText(content: Part["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((c) => (c.type === "text" || c.text ? (c.text ?? "") : `[${c.type ?? "content"}]`))
    .join("\n");
}

/** The token counts of a `result` line. */
export function turnUsage(msg: StreamMessage): TurnUsage | undefined {
  const u = msg.usage;
  if (!u) return undefined;
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
  };
}

/**
 * One parsed output line → contract events (ADR 0450):
 * - `system`/`init` → `agent.status` working;
 * - `assistant` text → `message` (≤ MESSAGE_MAX), `tool_use` → `tool` with its id (input ≤ 7,000);
 * - `user` `tool_result` → `tool.result` (output ≤ TOOL_OUTPUT_MAX, the end kept);
 * - `result` → `turn` (outcome, time, turns, token counts; never cost).
 * A subagent's own messages are left out (its Task call and result are shown). Everything else
 * (partial chunks, hook events, control responses) yields nothing. Ending the session is the
 * adapter's call, not this function's.
 */
export function streamMessageEvents(msg: StreamMessage): AdapterEvent[] {
  if (msg.type === "system" && msg.subtype === "init") {
    return [{ type: "agent.status", status: "working" }];
  }
  if (msg.parent_tool_use_id) return [];
  const content = msg.message?.content;
  if (msg.type === "assistant") {
    if (typeof content === "string") {
      return content.trim()
        ? [{ type: "message", role: "assistant", text: clip(content.trim(), MESSAGE_MAX) }]
        : [];
    }
    return (content ?? []).flatMap((part): AdapterEvent[] => {
      if (part.type === "text" && part.text?.trim()) {
        return [{ type: "message", role: "assistant", text: clip(part.text.trim(), MESSAGE_MAX) }];
      }
      if (part.type === "tool_use") {
        const input = JSON.stringify(part.input ?? {});
        return [
          {
            type: "tool",
            name: clip(part.name ?? "tool", 200),
            input: clip(input, STREAM_TOOL_INPUT_MAX),
            ...(part.id ? { id: part.id.slice(0, 100) } : {}),
          },
        ];
      }
      return [];
    });
  }
  if (msg.type === "user" && Array.isArray(content)) {
    return content.flatMap((part): AdapterEvent[] =>
      part.type === "tool_result" && part.tool_use_id
        ? [
            {
              type: "tool.result",
              toolId: part.tool_use_id.slice(0, 100),
              output: clipTail(resultText(part.content), TOOL_OUTPUT_MAX),
              ...(part.is_error ? { isError: true } : {}),
            },
          ]
        : [],
    );
  }
  if (msg.type === "result") {
    const ok = msg.subtype === "success" && !msg.is_error;
    const usage = turnUsage(msg);
    const error = ok
      ? null
      : [
          msg.subtype,
          typeof msg.result === "string" ? msg.result : null,
          ...(msg.errors ?? []).map(String),
        ]
          .filter(Boolean)
          .join(": ");
    return [
      {
        type: "turn",
        outcome: ok ? "success" : "error",
        ...(typeof msg.duration_ms === "number" && msg.duration_ms >= 0
          ? { durationMs: Math.round(msg.duration_ms) }
          : {}),
        ...(typeof msg.num_turns === "number" && msg.num_turns >= 0
          ? { turns: Math.round(msg.num_turns) }
          : {}),
        ...(usage ? { usage } : {}),
        ...(error ? { error: clip(error, TURN_ERROR_MAX) } : {}),
      },
    ];
  }
  return [];
}

/** One output line → events: a JSON line through `streamMessageEvents`, anything else as stdout. */
export function streamLineEvents(line: string): AdapterEvent[] {
  const msg = parseStreamLine(line);
  if (msg) return streamMessageEvents(msg);
  return line.trim() ? [{ type: "log", stream: "stdout", text: clip(line, 64_000) }] : [];
}

/** A user message on stdin (the prompt pointer, a steer). */
export function userMessageLine(text: string, sessionId?: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: sessionId ?? "",
  })}\n`;
}

/** Asks the session to stop its current turn (a control request), before it is handed over. */
export function interruptLine(requestId: string): string {
  return `${JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  })}\n`;
}

/**
 * The answer to a permission request the session sent anyway (`--permission-prompts none` should
 * mean none come): denied. Nobody watches a stream session to answer one, and policy is code.
 */
export function denyPermissionLine(requestId: string): string {
  return `${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "deny",
        message: "The software factory runs this session without permission prompts.",
      },
    },
  })}\n`;
}
