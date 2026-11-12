// A run's web terminal socket as the view sees it (spec 42, ADR 0500): the shared TerminalClient
// (packages/client) reads and writes it like a browser WebSocket, but it is the main process's socket
// on the client door, reached over the RPC. The view never sees the token or the socket's URL.
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

function fromBase64(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export class RpcTerminalSocket implements ViewerSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  readonly id: string;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly rpc: TerminalRpc,
    workItemId: string,
    runId: string,
    id: string = crypto.randomUUID(),
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
        this.fire("message", { data: e.data });
        return;
      case "bytes":
        this.fire("message", { data: fromBase64(e.base64) });
        return;
      case "close":
        this.closed(e.code, e.reason);
        return;
    }
  }

  private closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unsubscribe();
    this.fire("close", { code, reason });
  }

  private fire(type: string, event: unknown) {
    for (const l of this.listeners.get(type) ?? []) (l as (e: unknown) => void)(event);
  }
}
