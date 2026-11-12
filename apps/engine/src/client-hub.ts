// The ClientHub (spec 40 M2b, ADR 0380): one Durable Object per person, holding the live
// connections of their desktop apps. The outbox delivers each `notify` here, and the hub pushes it
// to every open socket, so the app updates its inbox count and shows a notification at once. It
// keeps no state: a socket that reconnects re-reads `inbox.list`, so nothing is lost but the push.
// Hibernatable WebSockets: an idle hub costs nothing.
import { DurableObject } from "cloudflare:workers";

export interface ClientEvent {
  type: "notify";
  event: string;
  title: string;
  workItemId: string | null;
}

export class ClientHub extends DurableObject<Env> {
  /** The door has already authenticated the caller; this only accepts the socket. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push one event to every open app of this person. Returns how many sockets got it. */
  async broadcast(event: ClientEvent): Promise<number> {
    const text = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
        sent++;
      } catch {
        // A socket that's going away; the app reconnects.
      }
    }
    return sent;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The app only pings; answer so it knows the line is alive.
    if (message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }
}

export const clientHub = (env: Env, userId: string) =>
  env.CLIENT_HUB.get(env.CLIENT_HUB.idFromName(userId));
