// The live connection to the person's ClientHub on sf-engine (spec 40 M2b): a push the moment a
// gate opens, so the badge and the notification don't wait for the next poll. Reconnects with
// backoff; every (re)connect re-reads the inbox, so a push missed while offline is caught up.
// Bun's WebSocket takes headers, so the token goes in Authorization, never in the URL.
import { nextRestart } from "./backoff.ts";
import { PROTOCOL_HEADERS } from "./protocol.ts";

export interface LiveEvent {
  type: "hello" | "notify";
  event?: string;
  title?: string;
  workItemId?: string | null;
}

export function liveUrl(engineUrl: string): string {
  const u = new URL(`${engineUrl.replace(/\/+$/, "")}/client/v1/live`);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

export class Live {
  private ws: WebSocket | null = null;
  private retries = 0;
  private openedAt = 0;
  private stopped = false;
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: () => string | null,
    private readonly on: { connected: () => void; event: (e: LiveEvent) => void },
  ) {}

  start(): void {
    this.stopped = false;
    if (this.ws) return;
    const token = this.token();
    if (!token) return;
    const headers = { authorization: `Bearer ${token}`, ...PROTOCOL_HEADERS };
    // biome-ignore lint/suspicious/noExplicitAny: Bun's WebSocket accepts { headers }, the DOM type doesn't say so.
    const ws = new WebSocket(this.url, { headers } as any);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.openedAt = Date.now();
      this.on.connected();
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    });
    ws.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      try {
        this.on.event(JSON.parse(String(e.data)) as LiveEvent);
      } catch {
        // not ours
      }
    });
    ws.addEventListener("close", () => this.closed());
    ws.addEventListener("error", () => ws.close());
  }

  private closed(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.ws = null;
    if (this.stopped || !this.token()) return;
    const { restarts, delayMs } = nextRestart(
      this.retries,
      this.openedAt ? Date.now() - this.openedAt : 0,
    );
    this.retries = restarts;
    this.openedAt = 0;
    setTimeout(() => this.start(), delayMs);
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
