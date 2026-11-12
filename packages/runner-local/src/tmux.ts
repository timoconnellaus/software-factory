// A thin wrapper over the `tmux` CLI on the factory's own socket (ADR 0370). Every call goes to
// `tmux -L software-factory -f /dev/null`: a server of the factory's alone, started without the
// owner's `~/.tmux.conf`, so the owner's own tmux server, sessions and config are never touched.
// A job's session is `sf-<jobId>`; targets use tmux's exact-match form (`=name`) so `sf-job_1`
// never matches `sf-job_10`.
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

export interface TmuxOptions {
  exec?: Exec;
  /** The executable (default `tmux` on PATH). */
  bin?: string;
  /** The socket name (default `software-factory`). Tests use their own. */
  socket?: string;
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

/** No server on the socket yet (or any more): not an error for reads. */
const NO_SERVER = /no server running|error connecting|failed to connect|No such file or directory/i;

export function tmuxCli(options: TmuxOptions = {}) {
  const exec = options.exec ?? nodeExec;
  const bin = options.bin ?? "tmux";
  const socket = options.socket ?? TMUX_SOCKET;

  const call = (args: string[]): Promise<ExecResult> =>
    exec(bin, ["-L", socket, "-f", "/dev/null", ...args], { timeoutMs: 20_000 });

  async function must(args: string[]): Promise<string> {
    const r = await call(args);
    if (r.code !== 0) {
      throw new TmuxError(`tmux ${args[0]} exited ${r.code}: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  const pane = (name: string) => `=${name}:`;

  return {
    socket,
    call,

    /**
     * A detached session running `command` in `cwd`. The pane stays after the command exits
     * (`remain-on-exit`), so its last screen can still be read; `kill` removes it.
     */
    async newSession(input: {
      name: string;
      cwd: string;
      command: string;
      width?: number;
      height?: number;
      historyLimit?: number;
    }): Promise<void> {
      await must([
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
      ]);
    },

    /** The session's pane, or null when the session is gone. */
    async paneState(name: string): Promise<PaneState | null> {
      const r = await call([
        "list-panes",
        "-t",
        `=${name}`,
        "-F",
        "#{pane_dead}\t#{pane_pid}\t#{history_size}",
      ]);
      if (r.code !== 0) return null;
      const [dead, pid, history] = (r.stdout.split("\n")[0] ?? "").split("\t");
      return {
        dead: dead === "1",
        pid: /^\d+$/.test(pid ?? "") ? Number(pid) : null,
        historySize: Number(history) || 0,
      };
    },

    /**
     * The pane's text: the visible screen by default, or lines `start`..`end` (negative numbers are
     * history lines, -1 the last). Null when the session is gone.
     */
    async capture(name: string, range?: { start: number; end: number }): Promise<string | null> {
      const r = await call([
        "capture-pane",
        "-p",
        "-J",
        "-t",
        pane(name),
        ...(range ? ["-S", String(range.start), "-E", String(range.end)] : []),
      ]);
      return r.code === 0 ? r.stdout : null;
    },

    /** Keys by name (`Enter`, `Down`), as tmux's send-keys reads them. */
    async sendKeys(name: string, ...keys: string[]): Promise<void> {
      await must(["send-keys", "-t", pane(name), ...keys]);
    },

    /** Text typed literally (`send-keys -l`): no key names, no Enter. */
    async sendText(name: string, text: string): Promise<void> {
      await must(["send-keys", "-t", pane(name), "-l", text]);
    },

    /** Kills the session. Already gone is fine. */
    async kill(name: string): Promise<void> {
      const r = await call(["kill-session", "-t", `=${name}`]);
      if (
        r.code !== 0 &&
        !/can't find session|no server running|error connecting/i.test(r.stderr)
      ) {
        throw new TmuxError(`tmux kill-session exited ${r.code}: ${r.stderr.trim()}`);
      }
    },

    /** Every session on the factory's socket; empty when its server isn't running. */
    async listSessions(): Promise<TmuxSession[]> {
      const r = await call([
        "list-sessions",
        "-F",
        "#{session_name}\t#{pane_dead}\t#{session_created}",
      ]);
      if (r.code !== 0) {
        if (NO_SERVER.test(r.stderr) || !r.stderr.trim()) return [];
        throw new TmuxError(`tmux list-sessions exited ${r.code}: ${r.stderr.trim()}`);
      }
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name = "", dead, created] = line.split("\t");
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
