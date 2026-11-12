// A run's web terminal for the view (spec 42, ADR 0530). The main process opens the client door's
// terminal socket with the desktop token in `Authorization` (as live.ts does: the token never reaches
// the view or a URL) and relays it over the RPC: the view opens, sends text frames and closes by a
// handle it chose; the main process pushes what the relay sends (binary output as base64). The relay
// decides who may type (ADR 0440); nothing here changes that.
//
// Every socket carries the protocol headers (ADR 0393). An upgrade the door refuses never opens, and
// the WebSocket API hides why, so a socket that closes without opening asks the same URL over plain
// HTTP once (live.ts's refusedAsTooOld): a 426 `update_required` closes it as UPDATE_REQUIRED and
// tells the app, which shows its "Update required" screen.
//
// Output is coalesced: a socket's bytes gather for one frame (OUTPUT_FLUSH_MS) and go to the view as
// one event, so a busy pane is a few dozen RPC messages a second, not one per relay frame. What waits
// is bounded (OUTPUT_PENDING_MAX): past it the socket closes with "the view fell behind" and the view
// offers Reconnect, which attaches afresh and redraws. Nothing grows without limit here.
import type { TerminalEvent } from "../shared/rpc.ts";
import { refusedAsTooOld } from "./live.ts";
import { PROTOCOL_HEADERS } from "./protocol.ts";

/** The most terminals open at once from this app. */
export const TERMINAL_SOCKETS_MAX = 4;
/** The largest text frame the view may send (the relay drops input over 4,096 characters anyway). */
export const TERMINAL_SEND_MAX = 32_768;

/** How long a socket's output gathers before it goes to the view: about one animation frame. */
export const OUTPUT_FLUSH_MS = 16;
/** The most output that may wait for the view, per socket. */
export const OUTPUT_PENDING_MAX = 1 << 20;
/** The close code and reason when the view can't keep up (1013: try again later). */
export const FELL_BEHIND = { code: 1013, reason: "the view fell behind: reconnect to redraw" };
/**
 * The close a refused upgrade gets when the door said this build is too old (426 `update_required`,
 * ADR 0393), as the live socket does: the view says "Update required", and the app looks for one.
 */
export const UPDATE_REQUIRED = {
  code: 4426,
  reason: "Update required: update the app (menu bar, Restart to update), then reopen the terminal",
};

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

function toBytes(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Runs `flush` once, later (a timer in the app; by hand in tests). */
export type Scheduler = (flush: () => void) => void;
const frame: Scheduler = (flush) => void setTimeout(flush, OUTPUT_FLUSH_MS);

export class Terminals {
  private readonly open_ = new Map<string, DoorSocket>();
  /** Output waiting for the next flush, per socket, in arrival order. */
  private readonly pending = new Map<string, { chunks: Buffer[]; bytes: number }>();
  private scheduled = false;

  constructor(
    private readonly engineUrl: string,
    private readonly token: () => string | null,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly socket: SocketFactory = bunSocket,
    private readonly schedule: Scheduler = frame,
    private readonly hooks: {
      /** The door refused this build as too old (ADR 0393). */
      updateRequired?: () => void;
      /** Asks why an upgrade was refused (tests pass a fake). */
      fetch?: typeof fetch;
    } = {},
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
    const url = terminalSocketUrl(this.engineUrl, p.workItemId, p.runId);
    const headers = { authorization: `Bearer ${token}`, ...PROTOCOL_HEADERS };
    const ws = this.socket(url, headers);
    ws.binaryType = "arraybuffer";
    this.open_.set(p.id, ws);
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.emit({ id: p.id, kind: "open" });
    });
    ws.addEventListener("message", (e) => {
      if (this.open_.get(p.id) !== ws) return;
      if (typeof e.data === "string") {
        // The relay's status messages keep their place after the output before them.
        this.flushOne(p.id);
        this.emit({ id: p.id, kind: "text", data: e.data });
        return;
      }
      const bytes = toBytes(e.data);
      if (bytes) this.queue(p.id, bytes);
    });
    ws.addEventListener("close", (e) => {
      if (this.open_.get(p.id) !== ws) return;
      this.flushOne(p.id);
      if (opened) {
        this.open_.delete(p.id);
        this.emit({ id: p.id, kind: "close", code: e.code, reason: e.reason });
        return;
      }
      // Never opened: was the upgrade refused because this build is too old? The handle stays
      // taken while the door is asked, so a close from the view meanwhile still wins.
      void refusedAsTooOld(url, headers, this.hooks.fetch).then((tooOld) => {
        if (this.open_.get(p.id) !== ws) return;
        this.open_.delete(p.id);
        if (tooOld) {
          this.emit({ id: p.id, kind: "close", ...UPDATE_REQUIRED });
          this.hooks.updateRequired?.();
        } else {
          this.emit({ id: p.id, kind: "close", code: e.code, reason: e.reason });
        }
      });
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

  close(
    p: { id: string },
    why: { code: number; reason: string } = { code: 1000, reason: "" },
  ): {
    ok: boolean;
  } {
    const ws = this.open_.get(p.id);
    if (!ws) return { ok: false };
    this.open_.delete(p.id);
    this.pending.delete(p.id);
    try {
      ws.close(why.code === 1000 ? 1000 : 4000, why.reason || "closed");
    } catch {
      // already closed
    }
    this.emit({ id: p.id, kind: "close", code: why.code, reason: why.reason });
    return { ok: true };
  }

  /**
   * Signing out, the window going, or the view (re)loading: every terminal closes. A reload or a
   * WebKit content-process restart leaves no view holding these handles, and each open socket holds
   * an attach, a relay viewer slot and the owner's pane size until closed.
   */
  closeAll(): void {
    for (const id of [...this.open_.keys()]) this.close({ id });
  }

  private queue(id: string, bytes: Buffer) {
    const q = this.pending.get(id) ?? { chunks: [], bytes: 0 };
    q.chunks.push(bytes);
    q.bytes += bytes.byteLength;
    this.pending.set(id, q);
    if (q.bytes > OUTPUT_PENDING_MAX) {
      this.close({ id }, FELL_BEHIND);
      return;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => {
        this.scheduled = false;
        for (const pid of [...this.pending.keys()]) this.flushOne(pid);
      });
    }
  }

  private flushOne(id: string) {
    const q = this.pending.get(id);
    if (!q) return;
    this.pending.delete(id);
    if (q.bytes === 0) return;
    this.emit({ id, kind: "bytes", base64: Buffer.concat(q.chunks).toString("base64") });
  }
}
