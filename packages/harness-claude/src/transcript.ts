// Reading what a Claude Code session did, after it ends. Claude keeps each session's transcript as
// JSONL under `<config dir>/projects/<cwd, with every non-alphanumeric character as "-">/`. From it
// the runner takes the check output (tests, lint, typecheck the agent ran, with their results) and
// the last thing the agent said, for the run's artifacts.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "@software-factory/runner-contract";

/** The transcript directory name Claude uses for a working directory. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The newest transcript for a working directory, modified at or after `since` (ms). It looks in the
 * run's account's config dir (ADR 0410; `configDirs`), else in whatever `claude` uses with no
 * account set (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
 */
export async function findTranscript(
  cwd: string,
  options: { since?: number; configDirs?: string[] } = {},
): Promise<string | null> {
  const name = projectDirName(cwd);
  let best: { path: string; mtime: number } | null = null;
  const defaultDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude");
  for (const root of options.configDirs ?? [defaultDir]) {
    const dir = join(root, "projects", name);
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      const { mtimeMs } = await stat(path);
      if (mtimeMs < (options.since ?? 0)) continue;
      if (!best || mtimeMs > best.mtime) best = { path, mtime: mtimeMs };
    }
  }
  return best?.path ?? null;
}

interface ContentPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { command?: string } & Record<string, unknown>;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
}
interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    id?: string;
    content?: string | ContentPart[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Tokens one model used in a session (spec 09 M3). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CommandRun {
  command: string;
  output: string;
  isError: boolean;
}

export interface TranscriptSummary {
  commands: CommandRun[];
  lastAssistantText: string | null;
  toolCalls: number;
  /** Tokens per model, from each assistant message's `usage` (one count per message id). */
  usage: ModelUsage[];
  /** First to last timestamped line, when the transcript has timestamps. */
  wallMs: number | null;
}

function text(content: ContentPart["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((c) => c.text ?? "").join("\n");
}

/** Parses a transcript's JSONL: every Bash command with its output, and the final assistant text. */
export function parseTranscript(jsonl: string): TranscriptSummary {
  const pending = new Map<string, string>();
  const commands: CommandRun[] = [];
  let lastAssistantText: string | null = null;
  let toolCalls = 0;
  const usage = new Map<string, ModelUsage>();
  const counted = new Set<string>();
  let first: number | null = null;
  let last: number | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isFinite(at)) {
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
    }
    const m = entry.message;
    // A message streams over several lines with the same id and usage: count it once.
    if (entry.type === "assistant" && m?.usage && m.model && !counted.has(m.id ?? line)) {
      counted.add(m.id ?? line);
      const u = usage.get(m.model) ?? {
        model: m.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      u.inputTokens += m.usage.input_tokens ?? 0;
      u.outputTokens += m.usage.output_tokens ?? 0;
      u.cacheReadTokens += m.usage.cache_read_input_tokens ?? 0;
      u.cacheWriteTokens += m.usage.cache_creation_input_tokens ?? 0;
      usage.set(m.model, u);
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (entry.type === "assistant" && part.type === "tool_use") {
        toolCalls++;
        if (part.name === "Bash" && part.id && typeof part.input?.command === "string") {
          pending.set(part.id, part.input.command);
        }
      } else if (entry.type === "assistant" && part.type === "text" && part.text?.trim()) {
        lastAssistantText = part.text.trim();
      } else if (entry.type === "user" && part.type === "tool_result" && part.tool_use_id) {
        const command = pending.get(part.tool_use_id);
        if (command === undefined) continue;
        pending.delete(part.tool_use_id);
        commands.push({ command, output: text(part.content), isError: part.is_error === true });
      }
    }
  }
  return {
    commands,
    lastAssistantText,
    toolCalls,
    usage: [...usage.values()],
    wallMs: first !== null && last !== null ? last - first : null,
  };
}

const CHECK = /\b(test|tests|vitest|jest|lint|biome|eslint|typecheck|tsc|check)\b/;

/** The check commands (tests, lint, typecheck) and their output, as one log. */
export function checkOutputLog(summary: TranscriptSummary, maxChars = 200_000): string | null {
  const runs = summary.commands.filter((c) => CHECK.test(c.command));
  if (runs.length === 0) return null;
  const body = runs
    .map((r) => `$ ${r.command}${r.isError ? "   [exit ≠ 0]" : ""}\n${r.output.trim()}\n`)
    .join("\n");
  return body.length > maxChars ? `…${body.slice(-maxChars)}` : body;
}

export async function readTranscript(path: string): Promise<TranscriptSummary> {
  return parseTranscript(await readFile(path, "utf8"));
}

/**
 * One stream-json line from headless `claude -p --output-format stream-json --verbose` (used by
 * runner-local) → contract events.
 */
export function streamJsonToEvents(line: string): AdapterEvent[] {
  let msg: {
    type?: string;
    subtype?: string;
    result?: string;
    is_error?: boolean;
    message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return line.trim() ? [{ type: "log", stream: "stdout", text: line }] : [];
  }
  if (msg.type === "system" && msg.subtype === "init") {
    return [{ type: "agent.status", status: "working" }];
  }
  if (msg.type === "assistant") {
    return (msg.message?.content ?? []).flatMap((part): AdapterEvent[] => {
      if (part.type === "tool_use") {
        const input = JSON.stringify(part.input ?? {});
        return [{ type: "tool", name: part.name ?? "", input: input.slice(0, 8_000) }];
      }
      if (part.type === "text" && part.text) {
        return [{ type: "log", stream: "stdout", text: part.text.slice(0, 64_000) }];
      }
      return [];
    });
  }
  if (msg.type === "result") {
    const ok = msg.subtype === "success" && !msg.is_error;
    return [
      { type: "agent.status", status: ok ? "done" : "error" },
      {
        type: "session.ended",
        outcome: ok ? "completed" : "failed",
        ...(msg.result ? { summary: msg.result } : {}),
      },
    ];
  }
  return [];
}
