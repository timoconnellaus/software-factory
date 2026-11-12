// A thin wrapper over the `tmux` CLI on the factory's own socket (ADR 0380). Every call goes to
// `tmux -L software-factory -f /dev/null`: a server of the factory's alone, started without the
// owner's `~/.tmux.conf`, so the owner's own tmux server, sessions and config are never touched.
// A job's session is `sf-<jobId>`; targets use tmux's exact-match form (`=name`) so `sf-job_1`
// never matches `sf-job_10`.
//
// A failed or timed-out tmux command is not "the session is gone" (ADR 0550, incident 2026-11-12
// #1): only tmux's own "can't find session" and "no server" answers mean gone. Anything else is
// retried with backoff and jitter, then reported as `TmuxUnavailable`.
import { setTimeout as sleep } from "node:timers/promises";
import { type Exec, type ExecResult, nodeExec } from "./exec.ts";

/** The factory's tmux socket name (`tmux -L software-factory`). */
export const TMUX_SOCKET = "software-factory";
export const SESSION_PREFIX = "sf-";

/** A job's tmux session name, which is also its worktree's directory name. */
export function sessionName(jobId: string): string {
  return `${SESSION_PREFIX}${jobId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The job id a session (or worktree) name names, or null when it isn't a job's. */
export function jobIdOfSession(name: string): string | null {
  return name.startsWith(SESSION_PREFIX) && name.length > SESSION_PREFIX.length
    ? name.slice(SESSION_PREFIX.length)
    : null;
}

/** What a person types to take a job's session over. */
export function attachCommand(name: string, socket = TMUX_SOCKET): string {
  return `tmux -L ${socket} attach -t ${name}`;
}

export class TmuxError extends Error {
  override name = "TmuxError";
}

/**
 * tmux didn't answer, or failed in a way that says nothing about the session (a timeout, a crash,
 * any other error), even after retrying. The session may well still be there: never read this as
 * "gone".
 */
export class TmuxUnavailable extends TmuxError {
  override name = "TmuxUnavailable";
}

/** The session (or the whole server) isn't there: the one answer that means gone. */
export class TmuxGone extends TmuxError {
  override name = "TmuxGone";
}

export interface TmuxOptions {
  exec?: Exec;
  /** The executable (default `tmux` on PATH). */
  bin?: string;
  /** The socket name (default `software-factory`). Tests use their own. */
  socket?: string;
  /** Each tmux command's timeout (default 20 s). */
  timeoutMs?: number;
  /** Tries per command before it counts as unavailable (default 4). */
  attempts?: number;
  /** The first retry's delay; each next one doubles, with jitter (default 500 ms). */
  backoffMs?: number;
}

export interface PaneState {
  dead: boolean;
  pid: number | null;
  historySize: number;
}

export interface TmuxSession {
  name: string;
  dead: boolean;
  /** Seconds since the epoch. */
  created: number;
}

/**
 * What tmux prints when there is no session to talk to, in tmux 3.3 (Debian 12) through 3.6a:
 * `cmd-find.c`'s "can't find session|window|pane: <target>" (`list-panes -t =name` resolves a
 * window, so a missing session says "can't find window"), and `client.c`'s "no server running on
 * <socket>" (ECONNREFUSED: a stale socket) or "error connecting to <socket> (No such file or
 * directory)" (ENOENT: no socket). Any other connect error (EAGAIN under load, EMFILE, …), a crash
 * ("server exited unexpectedly", "lost server") or a timeout is not "gone".
 */
export const TMUX_GONE =
  /^(can't find (session|window|pane): |no server running on |error connecting to \S+ \(No such file or directory\))/m;
const NO_SERVER = /^(no server running on |error connecting to \S+ \(No such file or directory\))/m;

export type TmuxAnswer = "ok" | "gone" | "error";

/** How to read one tmux result: done, the session is gone, or anything else (retry). */
export function classifyTmux(r: ExecResult): TmuxAnswer {
  if (r.timedOut) return "error";
  if (r.code === 0) return "ok";
  return TMUX_GONE.test(r.stderr) ? "gone" : "error";
}

export function tmuxCli(options: TmuxOptions = {}) {
  const exec = options.exec ?? nodeExec;
  const bin = options.bin ?? "tmux";
  const socket = options.socket ?? TMUX_SOCKET;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const attempts = Math.max(1, options.attempts ?? 4);
  const backoffMs = options.backoffMs ?? 500;

  const call = (args: string[]): Promise<ExecResult> =>
    exec(bin, ["-L", socket, "-f", "/dev/null", ...args], { timeoutMs });

  const explain = (args: string[], r: ExecResult) =>
    r.timedOut
      ? `tmux ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`
      : `tmux ${args[0]} exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`;

  /**
   * One command, retried with backoff and jitter while tmux fails in a way that isn't "gone".
   * `once`: a command that must not run twice (typing) is never retried: a timeout, a client killed
   * by a signal or a "lost server" can each come after the keys arrived.
   */
  async function attempt(
    args: string[],
    opts: { once?: boolean } = {},
  ): Promise<{ answer: "ok" | "gone"; r: ExecResult }> {
    let last: ExecResult = { stdout: "", stderr: "", code: 1 };
    let tries = 0;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        const delay = backoffMs * 2 ** (i - 1);
        await sleep(delay / 2 + Math.random() * delay);
      }
      tries++;
      const r = await call(args);
      const answer = classifyTmux(r);
      if (answer !== "error") return { answer, r };
      last = r;
      if (opts.once) break;
    }
    throw new TmuxUnavailable(`${explain(args, last)}${tries > 1 ? ` (tried ${tries}×)` : ""}`);
  }

  /** A command on a session that must be there. */
  async function must(args: string[], opts: { once?: boolean } = {}): Promise<string> {
    const { answer, r } = await attempt(args, opts);
    if (answer === "gone") throw new TmuxGone(explain(args, r));
    return r.stdout;
  }

  const pane = (name: string) => `=${name}:`;

  return {
    socket,
    call,

    /**
     * A detached session running `command` in `cwd`. The pane stays after the command exits
     * (`remain-on-exit`), so its last screen can still be read; `kill` removes it. Not retried: a
     * timed-out new-session may have started (the caller kills by name and stops the harness).
     */
    async newSession(input: {
      name: string;
      cwd: string;
      command: string;
      width?: number;
      height?: number;
      historyLimit?: number;
    }): Promise<void> {
      const args = [
        "start-server",
        ";",
        "set-option",
        "-g",
        "history-limit",
        String(input.historyLimit ?? 50_000),
        ";",
        "new-session",
        "-d",
        "-s",
        input.name,
        "-c",
        input.cwd,
        "-x",
        String(input.width ?? 200),
        "-y",
        String(input.height ?? 50),
        input.command,
        ";",
        "set-option",
        "-w",
        "-t",
        pane(input.name),
        "remain-on-exit",
        "on",
      ];
      const r = await call(args);
      if (r.code !== 0 || r.timedOut) {
        if (classifyTmux(r) === "error") throw new TmuxUnavailable(explain(args, r));
        throw new TmuxError(explain(args, r));
      }
    },

    /**
     * The session's pane, or null when the session is gone; throws `TmuxUnavailable` when tmux
     * can't say. Formats separate fields with `:`, not a tab: tmux 3.3 (Debian 12's) prints
     * control characters in `-F` output as `_`, and `:` can't be in a session name (spec 34, found
     * by `scripts/linux-check.sh`).
     */
    async paneState(name: string): Promise<PaneState | null> {
      const { answer, r } = await attempt([
        "list-panes",
        "-t",
        `=${name}`,
        "-F",
        "#{pane_dead}:#{pane_pid}:#{history_size}",
      ]);
      if (answer === "gone") return null;
      const [dead, pid, history] = (r.stdout.split("\n")[0] ?? "").split(":");
      return {
        dead: dead === "1",
        pid: /^\d+$/.test(pid ?? "") ? Number(pid) : null,
        historySize: Number(history) || 0,
      };
    },

    /**
     * The pane's text: the visible screen by default, or lines `start`..`end` (negative numbers are
     * history lines, -1 the last). Null when the session is gone; throws `TmuxUnavailable` when
     * tmux can't say.
     */
    async capture(name: string, range?: { start: number; end: number }): Promise<string | null> {
      const { answer, r } = await attempt([
        "capture-pane",
        "-p",
        "-J",
        "-t",
        pane(name),
        ...(range ? ["-S", String(range.start), "-E", String(range.end)] : []),
      ]);
      return answer === "ok" ? r.stdout : null;
    },

    /** Keys by name (`Enter`, `Down`), as tmux's send-keys reads them. */
    async sendKeys(name: string, ...keys: string[]): Promise<void> {
      await must(["send-keys", "-t", pane(name), ...keys], { once: true });
    },

    /** Text typed literally (`send-keys -l`): no key names, no Enter. Never typed twice. */
    async sendText(name: string, text: string): Promise<void> {
      await must(["send-keys", "-t", pane(name), "-l", text], { once: true });
    },

    /**
     * Kills the session. Already gone is fine; a tmux that doesn't answer throws `TmuxUnavailable`
     * (the caller stops the harness's processes itself, `stopHarness`).
     */
    async kill(name: string): Promise<void> {
      await attempt(["kill-session", "-t", `=${name}`]);
    },

    /**
     * Every session on the factory's socket; empty when its server isn't running. Throws
     * `TmuxUnavailable` when tmux can't say (never "no sessions").
     */
    async listSessions(): Promise<TmuxSession[]> {
      const args = ["list-sessions", "-F", "#{session_name}:#{pane_dead}:#{session_created}"];
      const { answer, r } = await attempt(args);
      if (answer === "gone") {
        if (NO_SERVER.test(r.stderr)) return [];
        throw new TmuxError(explain(args, r));
      }
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name = "", dead, created] = line.split(":");
          return { name, dead: dead === "1", created: Number(created) || 0 };
        });
    },

    /** The job sessions (`sf-*`) on the factory's socket. */
    async jobSessions(): Promise<TmuxSession[]> {
      return (await this.listSessions()).filter((s) => jobIdOfSession(s.name) !== null);
    },
  };
}

export type TmuxCli = ReturnType<typeof tmuxCli>;

/** `tmux -V` → [major, minor], or null when it can't be read. */
export function parseTmuxVersion(text: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether a `tmux -V` output is at least `min` (default 3.2, for `send-keys -l` and `-e`). */
export function tmuxAtLeast(text: string, min: [number, number] = [3, 2]): boolean {
  const v = parseTmuxVersion(text);
  return !!v && (v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1]));
}
