// The ClientHub (spec 40 M2b, ADR 0390): one Durable Object per person, holding the live
// connections of their desktop apps. The outbox delivers each `notify` here, and the hub pushes it
// to every open socket, so the app updates its inbox count and shows a notification at once. A
// device's socket is tagged with its id, and revoking the device closes it at once (ADR 0541). It
// keeps no state: a socket that reconnects re-reads `inbox.list`, so nothing is lost but the push.
// Hibernatable WebSockets: an idle hub costs nothing.
import { DurableObject } from "cloudflare:workers";

export type ClientEvent =
  | {
      type: "notify";
      event: string;
      title: string;
      workItemId: string | null;
    }
  /** A work item's planning changed, for the person who has its Planning view open (spec 26). */
  | { type: "planning.changed"; workItemId: string };

/** The device behind a live socket, set by the door from the token (never by the client). */
export const DEVICE_HEADER = "x-sf-device";
/** The close code a revoked device's socket gets: the app signs out instead of reconnecting. */
export const DEVICE_REVOKED_CLOSE = 4401;

export class ClientHub extends DurableObject<Env> {
  /** The door has already authenticated the caller; this only accepts the socket. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const device = request.headers.get(DEVICE_HEADER);
    this.ctx.acceptWebSocket(server, device ? [`device:${device}`] : []);
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

  /** Close every open socket of a revoked device (ADR 0541). Returns how many were closed. */
  async closeDevice(deviceId: string): Promise<number> {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets(`device:${deviceId}`)) {
      try {
        ws.close(DEVICE_REVOKED_CLOSE, "device revoked");
        closed++;
      } catch {
        // already closing
      }
    }
    return closed;
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
