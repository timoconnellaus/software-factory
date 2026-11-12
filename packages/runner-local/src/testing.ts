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
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
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
        return ok(`${s.dead ? 1 : 0}\t${options.pid ?? 4242}\t${s.history.length}\n`);
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
          `${[...sessions.values()].map((s) => `${s.name}\t${s.dead ? 1 : 0}\t0`).join("\n")}\n`,
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
