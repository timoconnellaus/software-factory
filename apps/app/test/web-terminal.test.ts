// The Live tab's web terminal (spec 35, ADR 0440): the socket route (session, same origin, the
// attach as the person, the viewer socket through the binding), the client's handling of the relay's
// frames, and when the view is offered.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveRunView } from "#/components/live-run-view";
import type { LiveView } from "#/lib/ops";
import {
  INITIAL_STATUS,
  statusText,
  TerminalClient,
  type TerminalStatus,
  terminalUrl,
  type ViewerSocket,
} from "#/lib/web-terminal";
import type { EngineRpc } from "#/server/engine";
import { handleTerminal, sameOrigin, TERMINAL_PATH } from "#/server/terminal";
import { recordingEngine, signIn, testEnv } from "./helpers.ts";

const ITEM = `wi_${"a".repeat(32)}`;
const RUN = `run_${"b".repeat(32)}`;
const URL_ = `http://localhost/api/work/${ITEM}/runs/${RUN}/terminal`;

describe("the web terminal's socket route", () => {
  it("opens the relay's viewer socket as the signed-in person, same origin only", async () => {
    const attaches: { workItemId: string; runId: string; actor: unknown }[] = [];
    const fetched: string[] = [];
    const { engine } = recordingEngine();
    const live: EngineRpc = {
      ...engine,
      async terminalAttach(workItemId, runId, options) {
        attaches.push({ workItemId, runId, actor: options.actor });
        if (runId !== RUN) return { ok: false, error: { code: "conflict", message: "ended" } };
        return {
          ok: true,
          jobId: "job_1",
          mode: "watch",
          attachId: "ta_1",
          path: "/terminal/v1/jobs/job_1/view?ticket=abc",
        };
      },
      async fetch(request) {
        fetched.push(request.url);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
        server.accept();
        return new Response(null, { status: 101, webSocket: client });
      },
    };
    const appEnv = testEnv(live);
    expect(TERMINAL_PATH.exec(new URL(URL_).pathname)?.slice(1)).toEqual([ITEM, RUN]);
    const upgrade = { upgrade: "websocket", origin: "http://localhost" };

    // Not a WebSocket, another site, nobody signed in.
    expect((await handleTerminal(appEnv, new Request(URL_), ITEM, RUN)).status).toBe(426);
    const { user, headers } = await signIn(appEnv, "timoconnellaus");
    const cookie = headers.get("cookie") ?? "";
    const cross = await handleTerminal(
      appEnv,
      new Request(URL_, { headers: { ...upgrade, origin: "https://evil.example", cookie } }),
      ITEM,
      RUN,
    );
    expect(cross.status).toBe(403);
    expect(
      (await handleTerminal(appEnv, new Request(URL_, { headers: upgrade }), ITEM, RUN)).status,
    ).toBe(401);
    expect(attaches).toEqual([]);

    const ok = await handleTerminal(
      appEnv,
      new Request(URL_, { headers: { ...upgrade, cookie } }),
      ITEM,
      RUN,
    );
    expect(ok.status).toBe(101);
    expect(ok.webSocket).toBeTruthy();
    expect(attaches).toEqual([
      { workItemId: ITEM, runId: RUN, actor: { type: "human", id: user.id } },
    ]);
    expect(fetched).toEqual(["https://sf-engine.internal/terminal/v1/jobs/job_1/view?ticket=abc"]);

    // A refusal from the operation is passed on as a status; nothing is opened.
    const other = `run_${"c".repeat(32)}`;
    const refused = await handleTerminal(
      appEnv,
      new Request(URL_.replace(RUN, other), { headers: { ...upgrade, cookie } }),
      ITEM,
      other,
    );
    expect(refused.status).toBe(409);
    expect(fetched).toHaveLength(1);
  });

  it("accepts the app's public origin and refuses a missing one", () => {
    const env = { PUBLIC_BASE_URL: "https://software-factory.example" };
    const req = (origin?: string) =>
      new Request("http://internal/api/x", { headers: origin ? { origin } : {} });
    expect(sameOrigin(env, req("https://software-factory.example"))).toBe(true);
    expect(sameOrigin(env, req("http://internal"))).toBe(true);
    expect(sameOrigin(env, req("https://software-factory.example.evil.com"))).toBe(false);
    expect(sameOrigin(env, req())).toBe(false);
  });
});

class Socket implements ViewerSocket {
  binaryType = "blob";
  readyState = 1;
  sent: string[] = [];
  private on = new Map<string, ((e: never) => void)[]>();
  addEventListener(type: string, l: (e: never) => void) {
    this.on.set(type, [...(this.on.get(type) ?? []), l]);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  emit(type: string, event: unknown) {
    for (const l of this.on.get(type) ?? []) l(event as never);
  }
}

function client() {
  const ws = new Socket();
  const writes: (string | Uint8Array)[] = [];
  const sizes: [number, number][] = [];
  const statuses: TerminalStatus[] = [];
  const c = new TerminalClient(
    ws,
    { write: (d) => writes.push(d), resize: (cols, rows) => sizes.push([cols, rows]) },
    (s) => statuses.push(s),
  );
  return { ws, c, writes, sizes, statuses };
}

describe("the web terminal client", () => {
  it("lets the owner type and resize once the relay says so, and draws the pane's output", () => {
    const { ws, c, writes, sizes, statuses } = client();
    expect(ws.binaryType).toBe("arraybuffer");
    // Before the relay says who this is, nothing is sent.
    c.type("x");
    c.fit(100, 30);
    expect(ws.sent).toEqual([]);

    ws.emit("message", {
      data: JSON.stringify({ t: "hello", mode: "type", viewers: 1, host: false }),
    });
    expect(statuses.at(-1)).toMatchObject({ phase: "waiting", mode: "type" });
    expect(statusText(statuses.at(-1) ?? INITIAL_STATUS)).toMatch(/You can type.*Waiting/);
    c.type("ls\r");
    c.fit(100, 30);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { t: "input", data: "ls\r" },
      { t: "resize", size: { cols: 100, rows: 30 } },
    ]);

    ws.emit("message", { data: JSON.stringify({ t: "viewers", viewers: 2, host: true }) });
    ws.emit("message", { data: JSON.stringify({ t: "size", size: { cols: 100, rows: 30 } }) });
    ws.emit("message", { data: new TextEncoder().encode("hi").buffer });
    expect(sizes).toEqual([[100, 30]]);
    expect(writes.map((w) => new TextDecoder().decode(w as Uint8Array))).toEqual(["hi"]);
    expect(statusText(statuses.at(-1) ?? INITIAL_STATUS)).toBe("You can type · 2 watching");

    ws.emit("message", { data: JSON.stringify({ t: "ended", reason: "the session ended" }) });
    ws.emit("close", { code: 1000, reason: "the session ended" });
    expect(statusText(statuses.at(-1) ?? INITIAL_STATUS)).toBe("The session ended.");
  });

  it("never sends a watcher's keys or size, and shows why a socket closed", () => {
    const { ws, c, sizes, statuses } = client();
    ws.emit("message", {
      data: JSON.stringify({ t: "hello", mode: "watch", viewers: 2, host: true }),
    });
    c.type("rm -rf /\r");
    c.fit(80, 24);
    expect(ws.sent).toEqual([]);
    // A watcher still draws the pane at its size.
    ws.emit("message", { data: JSON.stringify({ t: "size", size: { cols: 120, rows: 40 } }) });
    expect(sizes).toEqual([[120, 40]]);
    expect(statusText(statuses.at(-1) ?? INITIAL_STATUS)).toMatch(/Watching read-only/);
    ws.emit("close", { code: 1008, reason: "read-only: only the runner's owner can type" });
    expect(statuses.at(-1)).toMatchObject({ phase: "closed" });
    expect(statusText(statuses.at(-1) ?? INITIAL_STATUS)).toMatch(/read-only/);
  });

  it("builds the socket URL on the page's own origin", () => {
    expect(terminalUrl({ protocol: "https:", host: "sf.example" }, ITEM, RUN)).toBe(
      `wss://sf.example/api/work/${ITEM}/runs/${RUN}/terminal`,
    );
    expect(terminalUrl({ protocol: "http:", host: "localhost:3000" }, ITEM, RUN)).toMatch(
      /^ws:\/\//,
    );
  });
});

function liveView(terminal: LiveView["terminal"], active = true): LiveView {
  return {
    run: {
      id: RUN,
      jobId: "job_1",
      runNo: 1,
      stage: "build",
      status: active ? "running" : "handed_back",
      outcome: null,
      active,
      runnerId: "r_1",
      runnerName: "M5",
      startedAt: new Date(0).toISOString(),
      endedAt: null,
      takeover: null,
      mode: "terminal",
    },
    events: [],
    lastSeq: 0,
    truncated: false,
    steers: [],
    steer: { allowed: true, reason: null, max: 2000 },
    takeover: { allowed: false, reason: null, requested: false },
    terminal,
  };
}

const render = (data: LiveView, workItemId?: string) =>
  renderToStaticMarkup(
    createElement(LiveRunView, {
      data,
      me: "u_me",
      onSteer: async () => {},
      ...(workItemId ? { workItemId } : {}),
    }),
  );

describe("the Live tab's Web terminal view", () => {
  it("is offered next to Transcript and Terminal while the run is live on a runner that shares it", () => {
    const html = render(liveView({ allowed: true, mode: "watch", reason: "owner only" }), ITEM);
    expect(html).toContain('data-testid="live-web-terminal-tab"');
    expect(html).toContain("Web terminal");
    expect(html).toContain('data-testid="live-terminal-tab"');
  });

  it("isn't offered for a runner without it, an ended run, or without the work item", () => {
    const off = { allowed: false, mode: null, reason: "update it" } as const;
    expect(render(liveView(off), ITEM)).not.toContain("live-web-terminal-tab");
    expect(
      render(liveView({ allowed: true, mode: "type", reason: null }, false), ITEM),
    ).not.toContain("live-web-terminal-tab");
    expect(render(liveView({ allowed: true, mode: "type", reason: null }))).not.toContain(
      "live-web-terminal-tab",
    );
  });
});
