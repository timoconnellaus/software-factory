// runner-local's second session mode (ADR 0450): Claude Code headless as a long-lived two-way
// stream-json session, beside tmux (ADR 0380). The harness's own launch script (ADR 0270) runs as
// a child process with piped stdio; its argv carries the stream flags, so the launch record and
// the check of the live process before the prompt are the same as in tmux. The prompt pointer is
// the first JSON user message and steers are further ones. Events come straight from the
// structured output (no screen reads); the status hook stays projected as the cross-check and to
// follow the session after a person takes it over with `claude --resume`.
//
// Kept apart from adapter.ts so the tmux path and a container launch (plan piece 4) don't collide
// with it: adapter.ts calls in here only when the runner's session mode is `stream-json`.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  denyPermissionLine,
  inspectLaunch,
  interruptLine,
  launchProblems,
  PROMPT_FILE,
  PROMPT_POINTER,
  parseStreamLine,
  type ReadCommand,
  readStatusFrom,
  readTranscript,
  readTranscriptFrom,
  resumeCommand,
  scrubbedProcessEnv,
  streamMessageEvents,
  userMessageLine,
} from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  type AgentStatus,
  type Job,
  MESSAGE_MAX,
  RESULT_FILE,
  steerText,
  TAKEOVER_HINT_MAX,
} from "@software-factory/runner-contract";
import type { LocalSession, LocalWorkspace } from "./adapter.ts";
import { exists } from "./checkouts.ts";

/** How a session runs on this runner (`runner.json` `session`). */
export type LocalSessionMode = "tmux" | "stream-json";

/** A live stream session's process and what it has said, not yet read. */
export interface StreamState {
  child: ChildProcess;
  sessionId: string;
  /** The launch record's argv, worktree and unsets: what the takeover command is built from. */
  launch: LocalWorkspace["launch"];
  /** Complete stdout lines not yet read by `events()`. */
  lines: string[];
  /** stderr not yet read. */
  stderr: string;
  exited: { code: number | null; signal: string | null } | null;
  /** User messages sent: the prompt, then each steer. */
  sent: number;
  /** Result lines seen on stdout (read or not): a takeover waits for the interrupted turn's. */
  resultsSeen: number;
  /** `requested`: a person is taking the session over; `events()` follows the resumed one. */
  takeover: "none" | "requested";
  /** Resolves the current wait in `events()` (new output, an exit). */
  notify: () => void;
}

export interface StreamOptions {
  readCommand?: ReadCommand;
  startTimeoutMs: number;
  pollMs: number;
  waitingInputTimeoutMs: number;
  /**
   * After a turn's result while a steer's turn is still owed, how long to wait for it to start
   * before the job ends anyway (Claude may fold queued messages into one turn).
   */
  turnGraceMs?: number;
  /** The child's environment (default: the host's, with credentials dropped). */
  env?: Record<string, string>;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Kills a stream session's process group (the launch script and Claude). Safe when gone. */
export function killStream(state: StreamState | undefined, signal: NodeJS.Signals = "SIGKILL") {
  const pid = state?.child.pid;
  if (!state || !pid || state.exited) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      state.child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function write(state: StreamState, line: string): Promise<void> {
  const stdin = state.child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable || state.exited) {
    return Promise.reject(new Error("the session's input is closed"));
  }
  return new Promise((resolve, reject) => {
    stdin.write(line, (err) => (err ? reject(err) : resolve()));
  });
}

/** Waits until `notify` is called, `ms` pass or `signal` aborts. */
async function waitFor(state: StreamState, ms: number, signal: AbortSignal) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    state.notify = done;
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Starts the launch script with piped stdio and verifies it before the prompt (ADR 0270). */
export async function startStreamSession(
  job: Job,
  workspace: LocalWorkspace,
  signal: AbortSignal,
  options: StreamOptions,
  failure: (problems: string[]) => Error,
): Promise<LocalSession> {
  const sessionId = workspace.launch.stream?.sessionId;
  if (!sessionId) throw new Error(`job ${job.jobId} was not projected for a stream session`);
  const child = spawn("/bin/sh", [workspace.launchScript], {
    cwd: workspace.path,
    env: options.env ?? scrubbedProcessEnv(process.env, {}),
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so release can stop the script and Claude together.
    detached: true,
  });
  const state: StreamState = {
    child,
    sessionId,
    launch: workspace.launch,
    lines: [],
    stderr: "",
    exited: null,
    sent: 0,
    resultsSeen: 0,
    takeover: "none",
    notify: () => {},
  };
  let partial = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    partial += chunk;
    const parts = partial.split("\n");
    partial = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      state.lines.push(line);
      if (line.includes(`"type":"result"`)) state.resultsSeen++;
    }
    state.notify();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (state.stderr.length < 200_000) state.stderr += chunk;
    state.notify();
  });
  // A write after Claude exited is reported by `write`, not thrown at the host.
  child.stdin?.on("error", () => {});
  child.on("error", (err) => {
    state.stderr += `\n${err.message}`;
    state.exited ??= { code: null, signal: null };
    state.notify();
  });
  child.on("exit", (code, sig) => {
    if (partial.trim()) state.lines.push(partial);
    partial = "";
    state.exited = { code, signal: sig };
    state.notify();
  });

  const session: LocalSession = {
    jobId: job.jobId,
    sessionRef: `stream:${sessionId}`,
    name: workspace.name,
    worktreePath: workspace.path,
    runDir: workspace.runDir,
    statusFile: workspace.statusFile,
    launchScript: workspace.launchScript,
    startedAt: Date.now(),
    promptSentAt: Number.POSITIVE_INFINITY,
    mode: "stream",
    stream: state,
  };
  const fail = async (error: Error): Promise<never> => {
    killStream(state);
    throw error;
  };

  // Claude is up once the launch script has recorded its pid and exec'd: the live process is no
  // longer the shell running the script. Then it must be exactly what the harness set.
  const deadline = Date.now() + options.startTimeoutMs;
  for (;;) {
    if (signal.aborted) await fail(new Error(String(signal.reason ?? "cancelled")));
    if (state.exited) {
      await fail(new Error(`Claude exited before it started:\n${state.stderr.slice(-2_000)}`));
    }
    const observed = await inspectLaunch(workspace.launch, options.readCommand);
    if (observed.pid !== null && observed.command !== null) {
      if (!observed.command.includes(workspace.launchScript)) {
        const problems = launchProblems(workspace.launch, observed);
        if (problems.length > 0) await fail(failure(problems));
        break;
      }
    }
    if (Date.now() > deadline) {
      await fail(
        new Error(
          `Claude did not start within ${Math.round(options.startTimeoutMs / 1000)} s:\n${state.stderr.slice(-2_000)}`,
        ),
      );
    }
    await sleep(Math.min(options.pollMs, 100), undefined, { signal }).catch(() => {});
  }

  // The prompt is a file, as in tmux; the session's first message points at it.
  await writeFile(join(workspace.path, PROMPT_FILE), job.harness.prompt, { mode: 0o600 });
  session.startedAt = Date.now();
  session.promptSentAt = session.startedAt;
  try {
    await write(state, userMessageLine(PROMPT_POINTER, sessionId));
    state.sent = 1;
  } catch (err) {
    await fail(new Error(`sending the prompt: ${err instanceof Error ? err.message : err}`));
  }
  return session;
}

/** A person's message (ADR 0400) as one JSON user message. */
export async function steerStream(session: LocalSession, text: string): Promise<void> {
  const state = session.stream;
  if (!state) throw new Error("not a stream session");
  if (state.takeover !== "none") throw new Error("the session was taken over in a terminal");
  const line = steerText(text);
  if (!line) return;
  await write(state, userMessageLine(line, state.sessionId));
  state.sent++;
}

/**
 * Stops the stream session for a person (ADR 0450): interrupt the turn, close stdin, wait for
 * Claude to exit (it saves the conversation as it goes), then kill what is left. `events()` sees
 * the exit and follows the resumed session.
 */
export async function takeOverStream(
  session: LocalSession,
  options: { graceMs?: number } = {},
): Promise<void> {
  const state = session.stream;
  if (!state) throw new Error("not a stream session");
  if (state.takeover !== "none") return;
  state.takeover = "requested";
  state.notify();
  const grace = options.graceMs ?? 10_000;
  const exited = () => state.exited !== null;
  const until = async (ms: number, done = exited) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await sleep(20);
  };
  // Stop the turn and let it finish writing (its result), so the conversation is saved whole.
  const results = state.resultsSeen;
  await write(state, interruptLine(`sf-${randomUUID()}`)).catch(() => {});
  await until(Math.min(3_000, grace), () => exited() || state.resultsSeen > results);
  state.child.stdin?.end();
  await until(grace);
  if (!exited()) {
    killStream(state, "SIGTERM");
    await until(3_000);
  }
  if (!exited()) killStream(state, "SIGKILL");
}

/** Whether a turn's result line was the last one owed (every user message answered). */
function settled(state: StreamState, results: number) {
  return results >= state.sent;
}

export async function* streamEvents(
  job: Job,
  session: LocalSession,
  signal: AbortSignal,
  options: StreamOptions,
): AsyncIterable<AdapterEvent> {
  const state = session.stream;
  if (!state) throw new Error("not a stream session");
  const planning = job.stage === "planning";
  const resultPath = join(session.worktreePath, RESULT_FILE);
  const graceMs = options.turnGraceMs ?? 15_000;
  let status: AgentStatus | undefined;
  let results = 0;
  let graceUntil: number | null = null;
  let lastResult: string | undefined;
  const setStatus = (next: AgentStatus, message?: string): AdapterEvent[] => {
    if (next === status) return [];
    status = next;
    return [{ type: "agent.status", status: next, ...(message ? { message } : {}) }];
  };
  const stderrEvents = (): AdapterEvent[] => {
    if (!state.stderr.trim()) return [];
    const text = state.stderr;
    state.stderr = "";
    return [{ type: "log", stream: "stderr", text: clip(text, 60_000) }];
  };

  while (!signal.aborted) {
    while (state.lines.length > 0) {
      const line = state.lines.shift() as string;
      const msg = parseStreamLine(line);
      if (!msg) {
        if (line.trim()) yield { type: "log", stream: "stdout", text: clip(line, 60_000) };
        continue;
      }
      if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
        // `--permission-prompts none` means none should come; if one does, nobody answers it.
        if (msg.request_id) await write(state, denyPermissionLine(msg.request_id)).catch(() => {});
        continue;
      }
      for (const event of streamMessageEvents(msg)) {
        if (event.type === "agent.status") yield* setStatus(event.status, event.message);
        else yield event;
      }
      if (msg.type === "assistant" || msg.type === "user") {
        graceUntil = null;
        yield* setStatus("working");
      }
      if (msg.type === "result") {
        results++;
        const ok = msg.subtype === "success" && !msg.is_error;
        if (typeof msg.result === "string") lastResult = msg.result;
        if (state.takeover !== "none") continue;
        if (planning) {
          // A planning session stays open between turns (ADR 0300): the host stops it.
          yield* setStatus("idle");
          continue;
        }
        if (!settled(state, results)) {
          yield* setStatus("working");
          graceUntil = Date.now() + graceMs;
          continue;
        }
        yield* setStatus(ok ? "done" : "error");
        yield* stderrEvents();
        yield {
          type: "session.ended",
          outcome: ok ? "completed" : "failed",
          ...(lastResult ? { summary: lastResult } : {}),
        };
        return;
      }
    }
    yield* stderrEvents();

    if (state.exited && state.lines.length === 0) {
      if (state.takeover !== "none") {
        yield* followResumed(session, state, signal, options, status);
        return;
      }
      const hasResult = await exists(resultPath);
      yield {
        type: "session.ended",
        outcome: hasResult ? "completed" : "failed",
        summary:
          lastResult ??
          (hasResult
            ? "the agent exited after writing its result"
            : `the agent's session exited (${state.exited.code ?? state.exited.signal ?? "?"})`),
      };
      return;
    }
    if (graceUntil !== null && Date.now() > graceUntil) {
      yield* setStatus("done");
      yield {
        type: "session.ended",
        outcome: "completed",
        ...(lastResult ? { summary: lastResult } : {}),
      };
      return;
    }
    await waitFor(state, options.pollMs, signal);
  }
  const reason = String(signal.reason ?? "");
  yield { type: "session.ended", outcome: reason.includes("timeout") ? "timed_out" : "cancelled" };
}

async function sizeOf(path: string | null): Promise<number> {
  if (!path) return 0;
  return (await stat(path).catch(() => null))?.size ?? 0;
}

/**
 * After a takeover (ADR 0450): the `takeover` event with the resume command, then the resumed
 * session as the status hook and the transcript report it, until it ends. Only what happens after
 * the stream stopped is read. Quitting the resumed session hands the run back.
 */
async function* followResumed(
  session: LocalSession,
  state: StreamState,
  signal: AbortSignal,
  options: StreamOptions,
  current: AgentStatus | undefined,
): AsyncIterable<AdapterEvent> {
  const resultPath = join(session.worktreePath, RESULT_FILE);
  const hint = clip(resumeCommand(state.launch, state.sessionId), TAKEOVER_HINT_MAX - 1);
  // Where the stream's own record ends: everything after is the resumed session's. Read before
  // the command is shown, so nothing the person does is missed.
  let offset = await sizeOf(session.statusFile);
  let transcript = await transcriptFromStatus(session.statusFile);
  let transcriptOffset = await sizeOf(transcript);
  const takenAt = Date.now();
  yield { type: "takeover", sessionId: state.sessionId, hint };
  let status = current;
  const setStatus = (next: AgentStatus, message?: string): AdapterEvent[] => {
    if (next === status) return [];
    status = next;
    return [{ type: "agent.status", status: next, ...(message ? { message } : {}) }];
  };
  yield* setStatus("waiting_input", "taken over: resume it in a terminal");
  let resumed = false;
  const said = async (): Promise<AdapterEvent[]> => {
    if (!transcript) return [];
    const read = await readTranscriptFrom(transcript, transcriptOffset).catch(() => null);
    if (!read) return [];
    transcriptOffset = read.offset;
    return read.messages.map((m) => ({
      type: "message" as const,
      role: m.role,
      text: clip(m.text, MESSAGE_MAX - 1),
    }));
  };
  const ended = async (): Promise<AdapterEvent> => {
    const hasResult = await exists(resultPath);
    const summary = transcript
      ? ((await readTranscript(transcript).catch(() => null))?.lastAssistantText ?? undefined)
      : undefined;
    return {
      type: "session.ended",
      // The person ended it: the run goes back as it is, checked like any other (a build still
      // needs its commits).
      outcome: "completed",
      summary:
        summary ??
        (hasResult
          ? "the terminal session ended after writing its result"
          : "the terminal session ended"),
    };
  };

  while (!signal.aborted) {
    const read = await readStatusFrom(session.statusFile, offset);
    offset = read.offset;
    for (const line of read.lines) {
      if (line.transcript && line.transcript !== transcript) {
        transcript = line.transcript;
        // A transcript new to us (not the stream's) is read from its start.
        transcriptOffset = 0;
      }
    }
    yield* await said();
    for (const line of read.lines) {
      switch (line.event) {
        case "SessionStart":
          resumed = true;
          yield* setStatus("idle", "resumed in a terminal");
          break;
        case "UserPromptSubmit":
        case "PostToolUse":
          resumed = true;
          yield* setStatus("working");
          break;
        case "PreToolUse":
          resumed = true;
          yield* setStatus("working");
          yield {
            type: "tool",
            name: line.tool ?? "",
            ...(line.input ? { input: clip(line.input, 7_000) } : {}),
          };
          break;
        case "Stop":
          yield* setStatus("idle", "waiting for the person in the terminal");
          break;
        case "SessionEnd":
          if (!resumed) break;
          yield* await said();
          yield await ended();
          return;
      }
    }
    if (!resumed && Date.now() - takenAt > options.waitingInputTimeoutMs) {
      yield {
        type: "session.ended",
        outcome: "failed",
        summary: `taken over, but not resumed within ${Math.round(options.waitingInputTimeoutMs / 60_000)} min`,
      };
      return;
    }
    await sleep(Math.max(options.pollMs, 200), undefined, { signal }).catch(() => {});
  }
  const reason = String(signal.reason ?? "");
  yield { type: "session.ended", outcome: reason.includes("timeout") ? "timed_out" : "cancelled" };
}

/** The last transcript path the status hook reported. */
async function transcriptFromStatus(statusFile: string): Promise<string | null> {
  const { lines } = await readStatusFrom(statusFile, 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.transcript;
    if (t) return t;
  }
  return null;
}

/** Whether a session is a live stream one (for capacity). */
export function streamAlive(session: LocalSession | undefined): boolean {
  return !!session?.stream && session.stream.exited === null;
}

