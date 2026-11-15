// runner-local's second session mode (ADR 0450): Claude Code headless as a stream-json session,
// beside tmux (ADR 0380). The harness's own launch script (ADR 0270) runs as a child process with
// piped stdio; its argv carries the stream flags, so the launch record and the check of the live
// process before the prompt are the same as in tmux. The prompt pointer is the one JSON user
// message. Events come straight from the structured output (no screen reads): tool results and
// each turn's token counts, which a tmux session can't report.
//
// Kept apart from adapter.ts: adapter.ts calls in here only when the runner's session mode is
// `stream-json`.
import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  accountConfigDir,
  denyPermissionLine,
  inspectLaunch,
  launchProblems,
  PROMPT_FILE,
  PROMPT_POINTER,
  parseStreamLine,
  type ReadCommand,
  scrubbedProcessEnv,
  streamMessageEvents,
  userMessageLine,
} from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  type AgentStatus,
  type Job,
  RESULT_FILE,
} from "@software-factory/runner-contract";
import type { LocalSession, LocalWorkspace } from "./adapter.ts";
import { exists } from "./checkouts.ts";

/** How a session runs on this runner (`runner.json` `session`). */
export type LocalSessionMode = "tmux" | "stream-json";

/** A live stream session's process and what it has said, not yet read. */
export interface StreamState {
  child: ChildProcess;
  sessionId: string;
  /** Complete stdout lines not yet read by `events()`. */
  lines: string[];
  /** stderr not yet read. */
  stderr: string;
  exited: { code: number | null; signal: string | null } | null;
  /** Resolves the current wait in `events()` (new output, an exit). */
  notify: () => void;
}

export interface StreamOptions {
  readCommand?: ReadCommand;
  startTimeoutMs: number;
  pollMs: number;
  waitingInputTimeoutMs: number;
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
    lines: [],
    stderr: "",
    exited: null,
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
    account: workspace.account.name,
    configDir: accountConfigDir(workspace.account),
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
  } catch (err) {
    await fail(new Error(`sending the prompt: ${err instanceof Error ? err.message : err}`));
  }
  return session;
}

export async function* streamEvents(
  session: LocalSession,
  signal: AbortSignal,
  options: StreamOptions,
): AsyncIterable<AdapterEvent> {
  const state = session.stream;
  if (!state) throw new Error("not a stream session");
  const resultPath = join(session.worktreePath, RESULT_FILE);
  let status: AgentStatus | undefined;
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
      if (msg.type === "assistant" || msg.type === "user") yield* setStatus("working");
      // The one message's turn has ended: so has the job.
      if (msg.type === "result") {
        const ok = msg.subtype === "success" && !msg.is_error;
        if (typeof msg.result === "string") lastResult = msg.result;
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
    await waitFor(state, options.pollMs, signal);
  }
  const reason = String(signal.reason ?? "");
  yield { type: "session.ended", outcome: reason.includes("timeout") ? "timed_out" : "cancelled" };
}

/** Whether a session is a live stream one (for capacity). */
export function streamAlive(session: LocalSession | undefined): boolean {
  return !!session?.stream && session.stream.exited === null;
}
