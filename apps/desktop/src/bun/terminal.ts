// A run's web terminal for the view (spec 42, ADR 0500). The main process opens the client door's
// terminal socket with the desktop token in `Authorization` (as live.ts does: the token never reaches
// the view or a URL) and relays it over the RPC: the view opens, sends text frames and closes by a
// handle it chose; the main process pushes what the relay sends (binary output as base64). The relay
// decides who may type (ADR 0440); nothing here changes that.
import type { TerminalEvent } from "../shared/rpc.ts";

/** The most terminals open at once from this app. */
export const TERMINAL_SOCKETS_MAX = 4;
/** The largest text frame the view may send (the relay drops input over 4,096 characters anyway). */
export const TERMINAL_SEND_MAX = 32_768;

const ITEM = /^wi_[0-9a-f]{32}$/;
const RUN = /^run_[0-9a-f]{32}$/;
const HANDLE = /^[\w-]{8,64}$/;

/** The bits of a WebSocket this uses (Bun's, which takes headers; a fake in tests). */
export interface DoorSocket {
  binaryType: string;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => DoorSocket;

/** Bun's WebSocket takes `{ headers }`; the DOM type doesn't say so. */
export const bunSocket: SocketFactory = (url, headers) =>
  // biome-ignore lint/suspicious/noExplicitAny: Bun's WebSocket constructor accepts { headers }.
  new WebSocket(url, { headers } as any) as unknown as DoorSocket;

export function terminalSocketUrl(engineUrl: string, workItemId: string, runId: string): string {
  const u = new URL(`${engineUrl.replace(/\/+$/, "")}/client/v1/terminal/${workItemId}/${runId}`);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

function toBase64(data: unknown): string | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
  }
  return null;
}

export class Terminals {
  private readonly open_ = new Map<string, DoorSocket>();

  constructor(
    private readonly engineUrl: string,
    private readonly token: () => string | null,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly socket: SocketFactory = bunSocket,
  ) {}

  get count(): number {
    return this.open_.size;
  }

  open(p: { id: string; workItemId: string; runId: string }): {
    ok: boolean;
    error: string | null;
  } {
    if (!HANDLE.test(p.id) || !ITEM.test(p.workItemId) || !RUN.test(p.runId)) {
      return { ok: false, error: "not a run" };
    }
    if (this.open_.has(p.id)) return { ok: false, error: "already open" };
    if (this.open_.size >= TERMINAL_SOCKETS_MAX) {
      return { ok: false, error: "Too many terminals are open: close one first." };
    }
    const token = this.token();
    if (!token) return { ok: false, error: "Sign in to open the terminal." };
    const ws = this.socket(terminalSocketUrl(this.engineUrl, p.workItemId, p.runId), {
      authorization: `Bearer ${token}`,
    });
    ws.binaryType = "arraybuffer";
    this.open_.set(p.id, ws);
    ws.addEventListener("open", () => this.emit({ id: p.id, kind: "open" }));
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        this.emit({ id: p.id, kind: "text", data: e.data });
        return;
      }
      const base64 = toBase64(e.data);
      if (base64) this.emit({ id: p.id, kind: "bytes", base64 });
    });
    ws.addEventListener("close", (e) => {
      if (this.open_.get(p.id) !== ws) return;
      this.open_.delete(p.id);
      this.emit({ id: p.id, kind: "close", code: e.code, reason: e.reason });
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    });
    return { ok: true, error: null };
  }

  send(p: { id: string; data: string }): { ok: boolean } {
    const ws = this.open_.get(p.id);
    if (!ws) return { ok: false };
    if (ws.readyState !== 1 || typeof p.data !== "string") return { ok: false };
    if (p.data.length > TERMINAL_SEND_MAX) return { ok: false };
    try {
      ws.send(p.data);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  close(p: { id: string }): { ok: boolean } {
    const ws = this.open_.get(p.id);
    if (!ws) return { ok: false };
    this.open_.delete(p.id);
    try {
      ws.close(1000, "closed");
    } catch {
      // already closed
    }
    this.emit({ id: p.id, kind: "close", code: 1000, reason: "" });
    return { ok: true };
  }

  /** Signing out, or the window going: every terminal closes. */
  closeAll(): void {
    for (const id of [...this.open_.keys()]) this.close({ id });
  }
}
