// The factory's status hook (ADR 0350). A runner that hosts Claude Code's TUI in a plain terminal
// (runner-local: tmux) learns what the agent is doing from Claude Code's own hooks, not the screen.
// The projected settings run this hook on the status events below. It appends one JSON line per
// event to `<runDir>/status.jsonl` (event, time, tool name, a clipped input), never answers a
// permission decision, and always exits 0 with `{}` on stdout, whatever it was given. The adapter
// tails the file.
//
// The hook is a small Node script the harness writes into the run's private dir, run with the
// runner host's own absolute Node: no `jq`, no PATH lookups, and the run can't edit it (the run dir
// is outside the sandbox's writable paths and outside the worktree).
import { readFile } from "node:fs/promises";
import { shellQuote } from "./launch.ts";
import type { ClaudeHooks } from "./settings.ts";

export const STATUS_FILE = "status.jsonl";
export const STATUS_HOOK_SCRIPT = "status-hook.mjs";

/** The events the status hook runs on. */
export const STATUS_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;
export type StatusHookEvent = (typeof STATUS_HOOK_EVENTS)[number];

/** One line of `status.jsonl`. */
export interface StatusLine {
  event: string;
  /** ms since the epoch, when the hook ran. */
  time: number;
  tool?: string;
  /** The tool input, JSON, clipped. */
  input?: string;
  /** A notification's or a failure's message. */
  message?: string;
  /** A notification's type (`permission_prompt`, `idle_prompt`, …). */
  type?: string;
  /** Why a session ended or started (`SessionEnd` reason, `SessionStart` source). */
  reason?: string;
  /** The session's transcript, as Claude reports it. */
  transcript?: string;
}

/** Max characters of a tool input kept per line. */
export const STATUS_INPUT_MAX = 2_000;

/**
 * The hook's source. Self-contained (Node built-ins only). Every path ends in `{}` and exit 0: a
 * status hook must never block or decide anything, even on input it can't read.
 */
export function statusHookSource(): string {
  return `// Written by the software factory runner: the run's status hook (ADR 0350). It records the
// event and never answers a permission decision: it always prints {} and exits 0.
import { appendFileSync } from "node:fs";
const file = process.argv[2];
const MAX = ${STATUS_INPUT_MAX};
const clip = (s) => (typeof s === "string" ? (s.length > MAX ? s.slice(0, MAX) + "…" : s) : undefined);
let raw = "";
let done = false;
function finish() {
  if (done) return;
  done = true;
  try {
    const h = JSON.parse(raw || "{}");
    const line = { event: String(h.hook_event_name ?? "unknown"), time: Date.now() };
    if (typeof h.tool_name === "string") line.tool = h.tool_name;
    if (h.tool_input !== undefined) line.input = clip(JSON.stringify(h.tool_input));
    const message = h.message ?? h.error ?? h.error_message;
    if (message !== undefined) line.message = clip(typeof message === "string" ? message : JSON.stringify(message));
    if (typeof h.notification_type === "string") line.type = h.notification_type;
    const reason = h.reason ?? h.source;
    if (typeof reason === "string") line.reason = reason;
    if (typeof h.transcript_path === "string") line.transcript = h.transcript_path;
    if (file) appendFileSync(file, JSON.stringify(line) + "\\n");
  } catch {}
  try {
    process.stdout.write("{}\\n");
  } catch {}
  process.exit(0);
}
try {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (raw.length < 4000000) raw += chunk;
  });
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
  setTimeout(finish, 5000).unref();
} catch {
  finish();
}
`;
}

/** The hook's shell command: the host's Node, the script, the status file. */
export function statusHookCommand(node: string, script: string, file: string): string {
  return [node, script, file].map(shellQuote).join(" ");
}

/** The settings' hooks for the status hook, one entry per status event. */
export function statusHooks(command: string): ClaudeHooks {
  const hooks: ClaudeHooks = {};
  for (const event of STATUS_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command, timeout: 10 }] }];
  }
  return hooks;
}

/** Parses `status.jsonl` text into lines; a partial or garbled line is skipped. */
export function parseStatusLines(text: string): StatusLine[] {
  const out: StatusLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<StatusLine>;
      if (typeof parsed.event === "string" && typeof parsed.time === "number") {
        out.push(parsed as StatusLine);
      }
    } catch {
      // A line still being written, or not ours: skip it.
    }
  }
  return out;
}

/**
 * Reads the status file from a byte offset: the complete lines after it, and the offset to read
 * from next (a trailing partial line is left for the next read).
 */
export async function readStatusFrom(
  file: string,
  offset: number,
): Promise<{ lines: StatusLine[]; offset: number }> {
  const buf = await readFile(file).catch(() => null);
  if (!buf || buf.length <= offset)
    return { lines: [], offset: Math.min(offset, buf?.length ?? 0) };
  const end = buf.lastIndexOf(0x0a);
  if (end < offset) return { lines: [], offset };
  const text = buf.subarray(offset, end + 1).toString("utf8");
  return { lines: parseStatusLines(text), offset: end + 1 };
}
