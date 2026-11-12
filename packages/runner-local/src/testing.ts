// Test support: a scripted `tmux` for runner-local's tests and the runner host's. It answers the
// tmux commands the adapter uses, records every call, and stands in for Claude Code: on
// `new-session` it "runs" the launch script (the pid file, the hook's SessionStart), on a submitted
// prompt it records UserPromptSubmit and lets the test's agent work. Every other command goes to
// the real exec (git stays real). Not used at runtime.
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PID_FILE, STATUS_FILE, type StatusLine } from "@software-factory/harness-claude";
import { type Exec, type ExecResult, nodeExec } from "./exec.ts";

export * from "./container/testing.ts";
export * from "./sprites/fake.ts";
export * from "./sprites/ws-server.ts";

export interface FakeSession {
  name: string;
  cwd: string;
  runDir: string;
  statusFile: string;
  dead: boolean;
  /** Lines that scrolled off the screen. */
  history: string[];
  screen: string;
  /** What has been typed since the last Enter. */
  typed: string;
  /** Text submitted with Enter, in order (the prompt pointer, then steering). */
  submitted: string[];
  trustPending: boolean;
  /** What the pane runs, when the test spawned it (`spawn`): keys are written to it. */
  proc?: { write(data: string): void };
}

export interface ScriptedTmuxOptions {
  /** Claude shows its folder trust dialog first. */
  trustDialog?: boolean;
  /** Don't record SessionStart (Claude never comes up). */
  noSessionStart?: boolean;
  /** What the agent does after the first prompt is submitted. */
  onPrompt?: (session: FakeSession, append: (line: Partial<StatusLine>) => void) => unknown;
  /** Runs everything that isn't tmux (default: the real thing). */
  base?: Exec;
  pid?: number;
  /**
   * Runs the pane's script instead of standing in for Claude (a sprite job's bridge, ADR 0480):
   * typed text and keys go to what it returns, and the pane is dead once it sets `session.dead`.
   */
  spawn?: (session: FakeSession, script: string) => { write(data: string): void };
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
/** What a named key sends to a spawned pane. */
const KEYS: Record<string, string> = {
  Enter: "\r",
  Down: "\x1b[B",
  Up: "\x1b[A",
  Escape: "\x1b",
  "C-c": "\x03",
};
const err = (stderr: string): ExecResult => ({ stdout: "", stderr, code: 1 });

export function scriptedTmux(options: ScriptedTmuxOptions = {}) {
  const base = options.base ?? nodeExec;
  const sessions = new Map<string, FakeSession>();
  const calls: string[][] = [];
  const sockets = new Set<string>();

  const append = (s: FakeSession, line: Partial<StatusLine>) =>
    appendFileSync(s.statusFile, `${JSON.stringify({ time: Date.now(), ...line })}\n`);

  const target = (args: string[]) => {
    const t = args[args.indexOf("-t") + 1] ?? "";
    return t.replace(/^=/, "").replace(/:$/, "");
  };

  async function one(args: string[]): Promise<ExecResult> {
    const [verb, ...rest] = args;
    switch (verb) {
      case "start-server":
      case "set-option":
        return ok();
      case "new-session": {
        const name = rest[rest.indexOf("-s") + 1] ?? "";
        if (sessions.has(name)) return err(`duplicate session: ${name}`);
        const cwd = rest[rest.indexOf("-c") + 1] ?? "";
        const command = rest.at(-1) ?? "";
        const script = /exec \/bin\/sh '?([^']+?)'?$/.exec(command)?.[1];
        if (!script) return err(`bad command: ${command}`);
        const runDir = dirname(script);
        const s: FakeSession = {
          name,
          cwd,
          runDir,
          statusFile: join(runDir, STATUS_FILE),
          dead: false,
          history: [],
          screen: "",
          typed: "",
          submitted: [],
          trustPending: !!options.trustDialog,
        };
        sessions.set(name, s);
        if (options.spawn) {
          s.proc = options.spawn(s, script);
          return ok();
        }
        writeFileSync(join(runDir, PID_FILE), `${options.pid ?? 4242}\n`);
        if (s.trustPending) {
          s.screen = "Quick safety check\n❯ No, exit\n  Yes, I trust this folder";
        } else if (!options.noSessionStart) {
          append(s, { event: "SessionStart", reason: "startup" });
        }
        return ok();
      }
      case "list-panes": {
        const s = sessions.get(target(rest));
        if (!s) return err(`can't find window: ${target(rest)}`);
        return ok(`${s.dead ? 1 : 0}:${options.pid ?? 4242}:${s.history.length}\n`);
      }
      case "capture-pane": {
        const s = sessions.get(target(rest));
        if (!s) return err(`can't find session: ${target(rest)}`);
        const si = rest.indexOf("-S");
        if (si < 0) return ok(`${s.screen}\n`);
        const start = Number(rest[si + 1]);
        const lines = s.history.slice(s.history.length + start);
        return ok(`${lines.join("\n")}\n`);
      }
      case "send-keys": {
        const s = sessions.get(target(rest));
        if (!s) return err(`can't find pane: ${target(rest)}`);
        const li = rest.indexOf("-l");
        if (s.proc) {
          if (li >= 0) {
            s.proc.write(rest[li + 1] ?? "");
            return ok();
          }
          for (const key of rest.slice(rest.indexOf("-t") + 2)) {
            s.proc.write(KEYS[key] ?? "");
          }
          return ok();
        }
        if (li >= 0) {
          s.typed += rest[li + 1] ?? "";
          return ok();
        }
        const keys = rest.slice(rest.indexOf("-t") + 2);
        for (const key of keys) {
          if (s.trustPending) {
            if (key === "Enter") {
              s.trustPending = false;
              s.screen = "";
              if (!options.noSessionStart) append(s, { event: "SessionStart", reason: "startup" });
            }
            continue;
          }
          if (key === "Enter" && s.typed) {
            const text = s.typed;
            s.typed = "";
            s.submitted.push(text);
            append(s, { event: "UserPromptSubmit" });
            if (s.submitted.length === 1 && options.onPrompt) {
              await options.onPrompt(s, (line) => append(s, line));
            }
          }
        }
        return ok();
      }
      case "kill-session": {
        const name = target(rest);
        if (!sessions.delete(name)) return err(`can't find session: ${name}`);
        return ok();
      }
      case "list-sessions":
        if (sessions.size === 0) return err("no server running on /tmp/tmux-501/scripted");
        return ok(
          `${[...sessions.values()].map((s) => `${s.name}:${s.dead ? 1 : 0}:0`).join("\n")}\n`,
        );
      default:
        return err(`unscripted tmux ${verb}`);
    }
  }

  const exec: Exec = async (cmd, args, opts) => {
    if (cmd !== "tmux") return base(cmd, args, opts);
    calls.push(args);
    let rest = args;
    if (rest[0] === "-L") {
      sockets.add(rest[1] ?? "");
      rest = rest.slice(2);
    } else {
      sockets.add("default");
    }
    if (rest[0] === "-f") rest = rest.slice(2);
    // `a ; b ; c`: one tmux invocation, several commands.
    let last = ok();
    let current: string[] = [];
    for (const a of [...rest, ";"]) {
      if (a !== ";") {
        current.push(a);
        continue;
      }
      if (current.length) last = await one(current);
      if (last.code !== 0) return last;
      current = [];
    }
    return last;
  };

  return {
    exec,
    calls,
    sessions,
    /** Socket names tmux was called with (`default` for none). */
    sockets,
    append: (name: string, line: Partial<StatusLine>) => {
      const s = sessions.get(name);
      if (!s) throw new Error(`no session ${name}`);
      append(s, line);
    },
  };
}

/** What the stand-in stream-json `claude` does (`fakeStreamClaude`). */
export interface FakeStreamClaudeOptions {
  /** Every stdin line is appended here, so a test can see the prompt and the steers. */
  stdinLog: string;
  /** ms the first turn takes before it answers (a steer can arrive meanwhile). */
  firstTurnMs?: number;
  /** Commit a change to README.md during the first turn (a build that made something). */
  commit?: boolean;
  /** Write the stage result file (`.factory-result.json`) during the first turn. */
  writeResult?: boolean;
  /** Exit after the first turn's result instead of waiting for more input. */
  exitAfterFirst?: boolean;
  /** The first turn's result is an error. */
  failFirst?: boolean;
  /** Ask for a permission once (as if `--permission-prompts none` were ignored). */
  askPermission?: boolean;
}

/**
 * A stand-in `claude` that speaks stream-json (ADR 0450), for runner-local's and the runner
 * host's tests: an executable Node script the launch script `exec`s. It answers each JSON user
 * message with a turn (system init first, assistant text, a tool call and its result, then a
 * `result` with usage), answers an `interrupt`, and exits when stdin closes. Not used at runtime.
 */
export function fakeStreamClaude(options: FakeStreamClaudeOptions): string {
  return `#!${process.execPath}
// Written by runner-local's tests: a scripted stream-json Claude Code.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const opts = ${JSON.stringify(options)};
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = at("--session-id") ?? at("--resume") ?? "no-session";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let n = 0, inited = false, busy = Promise.resolve(), interrupted = false, asked = false;
let wake = () => {};
// A permission request waits for its answer, as Claude Code does: the turn goes on only once the
// runner's control_response for it arrives (else the test raced the job's end).
let answered = () => {};
const answer = new Promise((r) => { answered = r; });
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
async function turn(text) {
  n++;
  const k = n;
  if (!inited) { inited = true; out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" }); }
  if (k === 1 && opts.askPermission && !asked) {
    asked = true;
    out({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    await answer;
  }
  out({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text: "Turn " + k + ": " + text.slice(0, 40) }] } });
  out({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "tu_" + k, name: "Bash", input: { command: "echo " + k } }] } });
  if (k === 1 && opts.firstTurnMs) await sleep(opts.firstTurnMs);
  if (interrupted) { interrupted = false; out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, num_turns: k }); return; }
  out({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_" + k, content: "out " + k, is_error: false }] } });
  if (k === 1 && opts.commit) {
    appendFileSync("README.md", "hello from the stream\\n");
    execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qam", "stream change"]);
  }
  if (k === 1 && opts.writeResult) writeFileSync(".factory-result.json", JSON.stringify({ ok: true }));
  const fail = k === 1 && opts.failFirst;
  out({ type: "result", subtype: fail ? "error_max_turns" : "success", is_error: !!fail, result: "Done with turn " + k, session_id: sessionId, duration_ms: 1200, num_turns: 2, total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } });
  if (k === 1 && opts.exitAfterFirst) process.exit(0);
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    appendFileSync(opts.stdinLog, line + "\\n");
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "control_response" && msg.response?.request_id === "perm-1") answered();
    if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
      interrupted = true;
      wake();
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      continue;
    }
    if (msg.type === "user") {
      const text = typeof msg.message?.content === "string" ? msg.message.content : "";
      busy = busy.then(() => turn(text));
    }
  }
});
process.stdin.on("end", () => { busy.then(() => process.exit(0)); });
`;
}
