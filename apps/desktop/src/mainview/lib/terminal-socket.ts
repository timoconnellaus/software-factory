// A run's web terminal socket as the view sees it (spec 42, ADR 0530): the shared TerminalClient
// (packages/client) reads and writes it like a browser WebSocket, but it is the main process's socket
// on the client door, reached over the RPC. The view never sees the token or the socket's URL.
// Output is drawn once per animation frame, all that arrived since joined, and what waits is
// bounded: a hidden window (no frames) or a pane faster than xterm draws closes the socket with
// "the view fell behind" past VIEW_PENDING_MAX, and Reconnect attaches afresh and redraws.
import type { ViewerSocket } from "@software-factory/client/web-terminal";
import type { TerminalEvent } from "../../shared/rpc.ts";

export interface TerminalRpc {
  open(p: {
    id: string;
    workItemId: string;
    runId: string;
  }): Promise<{ ok: boolean; error: string | null }>;
  send(p: { id: string; data: string }): Promise<{ ok: boolean }>;
  close(p: { id: string }): Promise<{ ok: boolean }>;
  /** Every terminal event the main process pushes; returns the unsubscribe. */
  subscribe(listener: (event: TerminalEvent) => void): () => void;
}

type Listener = (event: never) => void;

/** The most output that may wait for the next frame, in bytes. */
export const VIEW_PENDING_MAX = 2 << 20;
/** Runs `draw` once, at the next frame (requestAnimationFrame in the app; by hand in tests). */
export type FrameScheduler = (draw: () => void) => void;
const nextFrame: FrameScheduler = (draw) =>
  typeof requestAnimationFrame === "function"
    ? void requestAnimationFrame(() => draw())
    : void setTimeout(draw, 16);

function fromBase64(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function join(chunks: Uint8Array[], total: number): ArrayBuffer {
  if (chunks.length === 1 && chunks[0]) return chunks[0].slice().buffer;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export class RpcTerminalSocket implements ViewerSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  readonly id: string;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly unsubscribe: () => void;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private drawScheduled = false;

  constructor(
    private readonly rpc: TerminalRpc,
    workItemId: string,
    runId: string,
    id: string = crypto.randomUUID(),
    private readonly frame: FrameScheduler = nextFrame,
  ) {
    this.id = id;
    this.unsubscribe = rpc.subscribe((e) => {
      if (e.id === this.id) this.event(e);
    });
    void rpc.open({ id, workItemId, runId }).then(
      (r) => {
        if (!r.ok) this.closed(1011, r.error ?? "couldn't open the terminal");
      },
      () => this.closed(1011, "couldn't open the terminal"),
    );
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    void this.rpc.send({ id: this.id, data }).catch(() => {});
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.rpc.close({ id: this.id }).catch(() => this.closed(1000, ""));
  }

  private event(e: TerminalEvent) {
    switch (e.kind) {
      case "open":
        this.readyState = 1;
        this.fire("open", undefined);
        return;
      case "text":
        // The relay's status keeps its place after the output before it.
        this.draw();
        this.fire("message", { data: e.data });
        return;
      case "bytes":
        this.queue(fromBase64(e.base64));
        return;
      case "close":
        this.closed(e.code, e.reason);
        return;
    }
  }

  private queue(bytes: Uint8Array) {
    if (this.readyState === 3) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    if (this.pendingBytes > VIEW_PENDING_MAX) {
      this.pending = [];
      this.pendingBytes = 0;
      this.readyState = 2;
      void this.rpc.close({ id: this.id }).catch(() => {});
      this.closed(1013, "the view fell behind: reconnect to redraw");
      return;
    }
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    this.frame(() => {
      this.drawScheduled = false;
      this.draw();
    });
  }

  /** Everything waiting, as one frame of output. */
  private draw() {
    if (this.pendingBytes === 0) return;
    const data = join(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    this.fire("message", { data });
  }

  private closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    if (code !== 1013) this.draw();
    this.readyState = 3;
    this.unsubscribe();
    this.fire("close", { code, reason });
  }

  private fire(type: string, event: unknown) {
    for (const l of this.listeners.get(type) ?? []) (l as (e: unknown) => void)(event);
  }
}
