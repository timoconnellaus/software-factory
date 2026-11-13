// The TerminalRelay (spec 35, ADR 0440): one Durable Object per job, relaying its web terminal. The
// runner host connects outbound with a one-use host ticket (minted here, handed to it by the signed
// channel's held `terminal` call); browsers connect through sf-app with a viewer ticket minted after
// `run.terminal.attach`. Output from the host goes to every viewer; input and resizes go to the host
// only from `type` viewers (the runner's owner): a `watch` socket that sends either is closed. The
// relay asks the host to redraw when a viewer joins and to stop when the last one leaves.
// While viewers are connected an alarm re-checks them every VIEWER_RECHECK_MS (spec 42, ADR 0530):
// a viewer whose person left the org, or whose desktop token or device was revoked or expired, is
// closed. Access is otherwise checked once, at the attach.
// Hibernatable WebSockets: an idle relay costs nothing. It keeps only its sockets and its tickets.
import { DurableObject } from "cloudflare:workers";
import { invoke, isOperationError } from "@software-factory/core";
import {
  clampSize,
  hostToRelaySchema,
  parseTerminalMessage,
  parseTerminalPath,
  type RelayToHost,
  type RelayToViewer,
  TERMINAL_FRAME_MAX,
  TERMINAL_INPUT_MAX,
  TERMINAL_MAX_VIEWERS,
  TERMINAL_TICKET_TTL_MS,
  type TerminalMode,
  type TerminalSize,
  viewerToRelaySchema,
} from "@software-factory/runner-contract";
import { invokeDeps } from "./deps.ts";

/** A viewer the app has attached (`run.terminal.attach`): who, on which work item, in which mode. */
export interface ViewerGrant {
  attachId: string;
  userId: string;
  workItemId: string;
  mode: TerminalMode;
  /** The desktop token it came in on (the client door), re-checked while it's open. */
  tokenId?: string;
}

/** How often open viewers are re-checked against membership and their token. */
export const VIEWER_RECHECK_MS = 60_000;

type Ticket = ({ role: "host" } | ({ role: "view" } & ViewerGrant)) & { exp: number };
type SocketMeta = { role: "host" } | ({ role: "viewer"; closed?: boolean } & ViewerGrant);

/** WebSocket close codes the relay uses. */
export const CLOSE = { normal: 1000, policy: 1008, replaced: 4000, revoked: 4001 } as const;

const TICKET_PREFIX = "ticket:";
const TYPER_SIZE = "typer-size";

function randomTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class TerminalRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime, so a page's keepalive never wakes a hibernated relay.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * A viewer ticket for an attach the operation recorded, or a refusal when the relay is full. The
   * ticket works once, within TERMINAL_TICKET_TTL_MS.
   */
  async admit(
    grant: ViewerGrant,
  ): Promise<{ ok: true; ticket: string } | { ok: false; reason: string }> {
    await this.pruneTickets();
    if (this.viewers().length >= TERMINAL_MAX_VIEWERS) {
      return { ok: false, reason: `at most ${TERMINAL_MAX_VIEWERS} people can watch one run` };
    }
    return { ok: true, ticket: await this.mint({ role: "view", ...grant }) };
  }

  /**
   * The runner host's held `terminal` call asks this once its poll sees an open attach (spec 44):
   * a fresh host ticket when a viewer is connected and no host is, else null; and how many viewers
   * are connected, from the relay's live sockets. Answered at once: nothing here waits.
   */
  async hostTicket(): Promise<{ ticket: string | null; viewers: number }> {
    const viewers = this.viewers().length;
    if (viewers > 0 && this.hosts().length === 0) {
      await this.pruneTickets();
      return { ticket: await this.mint({ role: "host" }), viewers };
    }
    return { ticket: null, viewers };
  }

  /** Who is connected (tests). */
  async state(): Promise<{ host: boolean; viewers: { userId: string; mode: TerminalMode }[] }> {
    return {
      host: this.hosts().length > 0,
      viewers: this.viewers().map(({ meta }) => ({ userId: meta.userId, mode: meta.mode })),
    };
  }

  /** A socket upgrade with a ticket: `/terminal/v1/jobs/<id>/host` or `/view`, `?ticket=…`. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const path = parseTerminalPath(url.pathname);
    const key = url.searchParams.get("ticket") ?? "";
    if (!path || !/^[0-9a-f]{64}$/.test(key)) return new Response("no ticket", { status: 401 });
    const ticket = await this.ctx.storage.get<Ticket>(TICKET_PREFIX + key);
    // One use: gone the moment it is presented, whatever happens next.
    if (ticket) await this.ctx.storage.delete(TICKET_PREFIX + key);
    if (!ticket || ticket.exp < Date.now() || (ticket.role === "host") !== (path.role === "host")) {
      return new Response("this ticket isn't valid", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    if (ticket.role === "host") {
      // A host that reconnects replaces the one before.
      for (const old of this.hosts()) this.closeSocket(old, CLOSE.replaced, "replaced");
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ role: "host" } satisfies SocketMeta);
      this.toHost({
        t: "open",
        size: (await this.ctx.storage.get<TerminalSize>(TYPER_SIZE)) ?? null,
      });
      this.broadcastViewers();
    } else {
      if (this.viewers().length >= TERMINAL_MAX_VIEWERS) {
        return new Response("too many viewers", { status: 409 });
      }
      const { role: _, exp: __, ...grant } = ticket;
      this.ctx.acceptWebSocket(server, ["viewer"]);
      server.serializeAttachment({ role: "viewer", ...grant } satisfies SocketMeta);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + VIEWER_RECHECK_MS);
      }
      const host = this.hosts().length > 0;
      this.send(server, { t: "hello", mode: grant.mode, viewers: this.viewers().length, host });
      this.broadcastViewers();
      // Without a host, the host's held call sees the attach on its next poll and asks hostTicket().
      if (host) this.toHost({ t: "redraw" });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    if (meta.role === "host") {
      if (typeof message !== "string") {
        // Output: to every viewer, unless the frame is over the cap.
        if (message.byteLength > TERMINAL_FRAME_MAX) return;
        for (const { ws: viewer } of this.viewers()) {
          try {
            viewer.send(message);
          } catch {
            // A viewer that's going away.
          }
        }
        return;
      }
      const msg = parseTerminalMessage(hostToRelaySchema, message);
      if (msg?.t === "size") {
        this.broadcast({ t: "size", size: clampSize(msg.size) });
      } else if (msg?.t === "ended") {
        await this.end(msg.reason || "the session ended");
      }
      return;
    }

    // A viewer. Only the runner's owner may type or resize: anyone else who tries is closed.
    const msg =
      typeof message === "string" ? parseTerminalMessage(viewerToRelaySchema, message) : null;
    if (typeof message !== "string" || (msg && meta.mode !== "type")) {
      if (meta.mode !== "type") {
        await this.dropViewer(
          ws,
          meta,
          CLOSE.policy,
          "read-only: only the runner's owner can type",
        );
      }
      return;
    }
    if (!msg) return;
    if (msg.t === "input") {
      if (msg.data.length === 0 || msg.data.length > TERMINAL_INPUT_MAX) return;
      this.toHost({ t: "input", data: msg.data });
    } else {
      const size = clampSize(msg.size);
      await this.ctx.storage.put(TYPER_SIZE, size);
      this.toHost({ t: "resize", size });
    }
  }

  override async alarm(): Promise<void> {
    await this.recheck();
    if (this.viewers().length > 0) await this.ctx.storage.setAlarm(Date.now() + VIEWER_RECHECK_MS);
  }

  /**
   * Closes each viewer who may no longer watch: no longer a member of the work item's org, or on a
   * desktop token that's revoked or expired, or whose device is revoked. Returns how many closed.
   */
  async recheck(): Promise<number> {
    const now = new Date().toISOString();
    let closed = 0;
    for (const { ws, meta } of this.viewers()) {
      const member = await this.env.DB.prepare(
        "SELECT 1 FROM core_work_items w JOIN core_member m ON m.organization_id = w.org_id WHERE w.id = ? AND m.user_id = ?",
      )
        .bind(meta.workItemId, meta.userId)
        .first();
      let why = member ? null : "you're no longer a member of this organization";
      if (!why && meta.tokenId) {
        const token = await this.env.DB.prepare(
          "SELECT 1 FROM core_cli_tokens t JOIN core_desktop_devices d ON d.id = t.device_id WHERE t.id = ? AND t.user_id = ? AND t.revoked_at IS NULL AND d.revoked_at IS NULL AND t.expires_at > ?",
        )
          .bind(meta.tokenId, meta.userId, now)
          .first();
        if (!token) why = "this app's sign-in was revoked or has expired";
      }
      if (!why) continue;
      await this.dropViewer(ws, meta, CLOSE.revoked, why);
      closed++;
    }
    return closed;
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.gone(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws, CLOSE.normal);
  }

  private async gone(ws: WebSocket, code: number) {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    try {
      ws.close(code === 1005 || code === 1006 ? CLOSE.normal : code, "closing");
    } catch {
      // already closed
    }
    if (!meta) return;
    if (meta.role === "viewer") {
      await this.detach(meta);
      this.afterViewerLeft(ws);
    } else {
      this.broadcastViewers(ws);
      // Viewers are still waiting: the host's next held call gets a fresh ticket from hostTicket().
    }
  }

  /** The session ended: tell the viewers, close everyone. */
  private async end(reason: string) {
    for (const { ws, meta } of this.viewers()) {
      this.send(ws, { t: "ended", reason });
      await this.dropViewer(ws, meta, CLOSE.normal, "the session ended", false);
    }
    for (const host of this.hosts()) this.closeSocket(host, CLOSE.normal, "the session ended");
    await this.ctx.storage.delete(TYPER_SIZE);
  }

  private async dropViewer(
    ws: WebSocket,
    meta: Extract<SocketMeta, { role: "viewer" }>,
    code: number,
    reason: string,
    notify = true,
  ) {
    ws.serializeAttachment({ ...meta, closed: true } satisfies SocketMeta);
    this.closeSocket(ws, code, reason);
    await this.detach(meta);
    if (notify) this.afterViewerLeft(ws);
  }

  /** The last viewer gone: the host stops its bridge. Otherwise everyone hears the new count. */
  private afterViewerLeft(left: WebSocket) {
    if (this.viewers(left).length === 0) {
      for (const host of this.hosts()) {
        this.send(host, { t: "close", reason: "nobody is watching" } satisfies RelayToHost);
        this.closeSocket(host, CLOSE.normal, "nobody is watching");
      }
    } else {
      this.broadcastViewers(left);
    }
  }

  /** Journals the close (`run.terminal.detach`, as the viewer). Closing twice changes nothing. */
  private async detach(meta: ViewerGrant) {
    try {
      await invoke(
        invokeDeps(this.env),
        "run.terminal.detach",
        { workItemId: meta.workItemId, attachId: meta.attachId },
        { actor: { type: "human", id: meta.userId }, origin: { surface: "app" } },
      );
    } catch (error) {
      if (!isOperationError(error)) console.error("terminal detach failed", error);
    }
  }

  private async mint(ticket: { role: "host" } | ({ role: "view" } & ViewerGrant)): Promise<string> {
    const key = randomTicket();
    await this.ctx.storage.put(TICKET_PREFIX + key, {
      ...ticket,
      exp: Date.now() + TERMINAL_TICKET_TTL_MS,
    } as Ticket);
    return key;
  }

  private async pruneTickets() {
    const now = Date.now();
    const all = await this.ctx.storage.list<Ticket>({ prefix: TICKET_PREFIX });
    const stale = [...all].filter(([, t]) => t.exp < now).map(([k]) => k);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  private hosts(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets("host").filter((ws) => ws !== except && open(ws));
  }

  private viewers(except?: WebSocket) {
    return this.ctx
      .getWebSockets("viewer")
      .filter((ws) => ws !== except && open(ws))
      .map((ws) => ({
        ws,
        meta: ws.deserializeAttachment() as Extract<SocketMeta, { role: "viewer" }>,
      }))
      .filter(({ meta }) => meta && !meta.closed);
  }

  private toHost(message: RelayToHost) {
    for (const host of this.hosts()) this.send(host, message);
  }

  private broadcast(message: RelayToViewer, except?: WebSocket) {
    for (const { ws } of this.viewers(except)) this.send(ws, message);
  }

  private broadcastViewers(except?: WebSocket) {
    this.broadcast(
      { t: "viewers", viewers: this.viewers(except).length, host: this.hosts(except).length > 0 },
      except,
    );
  }

  private send(ws: WebSocket, message: RelayToViewer | RelayToHost) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // A socket that's going away.
    }
  }

  private closeSocket(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

/** WebSocket.OPEN: a socket the relay closed (or that is closing) no longer counts. */
const open = (ws: WebSocket) => ws.readyState === 1;

/** The job's relay. */
export function terminalRelay(env: Env, jobId: string) {
  return env.TERMINAL_RELAY.get(env.TERMINAL_RELAY.idFromName(jobId));
}
