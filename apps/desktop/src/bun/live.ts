// The live connection to the person's ClientHub on sf-engine (spec 40 M2b): a push the moment a
// gate opens, so the badge and the notification don't wait for the next poll. Reconnects with
// backoff; every (re)connect re-reads the inbox, so a push missed while offline is caught up.
// Bun's WebSocket takes headers, so the token goes in Authorization, never in the URL.
// A refused upgrade (the engine's 426 `update_required`, ADR 0393) isn't retried: the WebSocket
// API hides the status, so a socket that closes without ever opening asks the same URL over plain
// HTTP once, and a 426 there shows "Update required" and stops reconnecting.
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

/** The live URL as a plain HTTP(S) URL, for asking why an upgrade was refused. */
export const httpUrl = (wsUrl: string) => wsUrl.replace(/^ws(s?):/, "http$1:");

/** True when the door refused this build as too old (426 `update_required`). */
export async function refusedAsTooOld(
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetcher(httpUrl(url), { headers });
    if (res.status !== 426) return false;
    const json = (await res.json().catch(() => ({}))) as { code?: unknown };
    return json.code === "update_required";
  } catch {
    return false;
  }
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
    private readonly on: {
      connected: () => void;
      event: (e: LiveEvent) => void;
      /** The engine refused this build (ADR 0393): no reconnecting until start() is called again. */
      updateRequired?: () => void;
    },
    private readonly deps: {
      socket?: (url: string, headers: Record<string, string>) => WebSocket;
      fetch?: typeof fetch;
      setTimeout?: (fn: () => void, ms: number) => unknown;
    } = {},
  ) {}

  start(): void {
    this.stopped = false;
    if (this.ws) return;
    const token = this.token();
    if (!token) return;
    const headers = { authorization: `Bearer ${token}`, ...PROTOCOL_HEADERS };
    const ws = this.deps.socket
      ? this.deps.socket(this.url, headers)
      : // biome-ignore lint/suspicious/noExplicitAny: Bun's WebSocket accepts { headers }, the DOM type doesn't say so.
        new WebSocket(this.url, { headers } as any);
    this.ws = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
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
    ws.addEventListener("close", () => void this.closed(opened, headers));
    ws.addEventListener("error", () => ws.close());
  }

  private async closed(opened: boolean, headers: Record<string, string>): Promise<void> {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    this.ws = null;
    if (this.stopped || !this.token()) return;
    // Never opened: was the upgrade refused because this build is too old?
    if (!opened && (await refusedAsTooOld(this.url, headers, this.deps.fetch))) {
      this.stopped = true;
      this.on.updateRequired?.();
      return;
    }
    if (this.stopped) return;
    const { restarts, delayMs } = nextRestart(
      this.retries,
      this.openedAt ? Date.now() - this.openedAt : 0,
    );
    this.retries = restarts;
    this.openedAt = 0;
    (this.deps.setTimeout ?? setTimeout)(() => this.start(), delayMs);
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
