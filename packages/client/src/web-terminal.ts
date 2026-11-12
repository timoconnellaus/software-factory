// The web terminal's client (spec 35, ADR 0440), framework-free and shared by sf-app's Live tab and
// the desktop app (spec 42, ADR 0530): it turns the relay's frames into terminal writes and a status
// line, and sends the owner's keys and size. The relay enforces who may type; a watcher's client
// never sends input or a size. The socket is whatever the front end has: a browser WebSocket to
// sf-app's route, or the desktop's socket over its RPC to the main process.
import {
  parseTerminalMessage,
  relayToViewerSchema,
  TERMINAL_INPUT_MAX,
  type TerminalMode,
} from "@software-factory/runner-contract";

/** What the client draws on (xterm.js in the page; a recorder in tests). */
export interface TermLike {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
}

/** The bits of a browser WebSocket the client uses. */
export interface ViewerSocket {
  binaryType: string;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
}

export type TerminalPhase = "connecting" | "waiting" | "live" | "ended" | "closed";

export interface TerminalStatus {
  phase: TerminalPhase;
  mode: TerminalMode | null;
  viewers: number;
  message: string | null;
}

export const INITIAL_STATUS: TerminalStatus = {
  phase: "connecting",
  mode: null,
  viewers: 0,
  message: null,
};

/** The status line under the terminal. */
export function statusText(s: TerminalStatus): string {
  const who =
    s.mode === "type"
      ? "You can type: typing takes the session over"
      : s.mode === "watch"
        ? "Watching read-only: only the runner's owner can type"
        : "";
  const others = s.viewers > 1 ? ` · ${s.viewers} watching` : "";
  switch (s.phase) {
    case "connecting":
      return "Connecting…";
    case "waiting":
      return `${who}${others} · Waiting for the runner to connect…`;
    case "live":
      return `${who}${others}`;
    case "ended":
      return s.message ?? "The session ended.";
    case "closed":
      return s.message ?? "Disconnected.";
  }
}

export class TerminalClient {
  status: TerminalStatus = INITIAL_STATUS;

  constructor(
    private readonly ws: ViewerSocket,
    private readonly term: TermLike,
    private readonly onStatus: (status: TerminalStatus) => void,
  ) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => this.message(event.data));
    ws.addEventListener("close", (event) => {
      if (this.status.phase === "ended") return;
      this.set({
        phase: "closed",
        message:
          event.code === 1008
            ? `Closed: ${event.reason || "read-only"}.`
            : event.code === 1000 && event.reason
              ? `Closed: ${event.reason}.`
              : "Disconnected.",
      });
    });
  }

  /** Keys the person typed: sent only when they may type. */
  type(data: string) {
    if (this.status.mode !== "type" || !data) return;
    for (let i = 0; i < data.length; i += TERMINAL_INPUT_MAX) {
      this.send({ t: "input", data: data.slice(i, i + TERMINAL_INPUT_MAX) });
    }
  }

  /** The size the person's window fits: the pane follows it, only for the runner's owner. */
  fit(cols: number, rows: number) {
    if (this.status.mode !== "type" || !(cols > 0) || !(rows > 0)) return;
    this.send({ t: "resize", size: { cols, rows } });
  }

  close() {
    try {
      this.ws.close(1000, "closed");
    } catch {
      // already closed
    }
  }

  private message(data: unknown) {
    if (typeof data !== "string") {
      if (data instanceof ArrayBuffer) this.term.write(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) {
        this.term.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      return;
    }
    const m = parseTerminalMessage(relayToViewerSchema, data);
    if (!m) return;
    switch (m.t) {
      case "hello":
        this.set({ mode: m.mode, viewers: m.viewers, phase: m.host ? "live" : "waiting" });
        return;
      case "viewers":
        this.set({ viewers: m.viewers, phase: m.host ? "live" : "waiting" });
        return;
      case "size":
        // Everyone draws the pane at its real size.
        this.term.resize(m.size.cols, m.size.rows);
        return;
      case "ended":
        this.set({ phase: "ended", message: m.reason ? `${capital(m.reason)}.` : null });
        return;
    }
  }

  private send(message: object) {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      // closing
    }
  }

  private set(patch: Partial<TerminalStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
