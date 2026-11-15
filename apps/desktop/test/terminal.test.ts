// The desktop's web terminal (spec 42, ADR 0530): the main process's socket on the client door (the
// token only in its Authorization header, ids checked, a cap on open sockets, sign-out closes them).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOOR_PROTOCOL } from "../src/bun/protocol.ts";
import {
  type DoorSocket,
  FELL_BEHIND,
  OUTPUT_PENDING_MAX,
  TERMINAL_SOCKETS_MAX,
  Terminals,
  terminalSocketUrl,
  UPDATE_REQUIRED,
} from "../src/bun/terminal.ts";
import type { TerminalEvent } from "../src/shared/rpc.ts";

const ITEM = `wi_${"a".repeat(32)}`;
const RUN = `run_${"b".repeat(32)}`;

/** A door socket that records what was sent and lets the test play the relay. */
class FakeSocket implements DoorSocket {
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  private l: Record<string, ((e: never) => void)[]> = {};
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  addEventListener(type: string, listener: (e: never) => void) {
    this.l[type] = [...(this.l[type] ?? []), listener];
  }
  fire(type: string, e?: unknown) {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const f of this.l[type] ?? []) (f as (e: unknown) => void)(e);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
  }
}

/** Scheduled work that runs when the test says (a frame, by hand). */
function frames() {
  let due: (() => void)[] = [];
  return {
    schedule: (f: () => void) => {
      due.push(f);
    },
    get waiting() {
      return due.length;
    },
    run() {
      const now = due;
      due = [];
      for (const f of now) f();
    },
  };
}

/** The door's plain-HTTP answer to "why was the upgrade refused?" (none by default). */
type Door = (url: string, headers: Record<string, string>) => Response;
const notTooOld: Door = () =>
  Response.json({ error: "expected a WebSocket upgrade", code: "invalid_input" }, { status: 426 });

function mainProcess(token: string | null = "sfd_secret", door: Door = notTooOld) {
  const events: TerminalEvent[] = [];
  const sockets: FakeSocket[] = [];
  const timer = frames();
  const asked: { url: string; headers: Record<string, string> }[] = [];
  let updateRequired = 0;
  const terminals = new Terminals(
    "https://sf-engine.example",
    () => token,
    (e) => events.push(e),
    (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    timer.schedule,
    {
      updateRequired: () => updateRequired++,
      fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
        const headers = init?.headers ?? {};
        asked.push({ url, headers });
        return door(url, headers);
      }) as unknown as typeof fetch,
    },
  );
  return {
    terminals,
    events,
    sockets,
    timer,
    asked,
    get updateRequired() {
      return updateRequired;
    },
  };
}

/** Lets the door's answer (a promise) land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the main process's terminal sockets", () => {
  it("opens the door's terminal socket with the token in Authorization, never in the URL", () => {
    const main = mainProcess();
    const { terminals, sockets, events } = main;
    expect(terminals.open({ id: "view-0001", workItemId: ITEM, runId: RUN })).toEqual({
      ok: true,
      error: null,
    });
    const s = sockets[0];
    expect(s?.url).toBe(`wss://sf-engine.example/client/v1/terminal/${ITEM}/${RUN}`);
    expect(s?.url).not.toContain("sfd_");
    expect(s?.headers).toEqual({
      authorization: "Bearer sfd_secret",
      "x-sf-client": "desktop",
      "x-sf-client-protocol": String(DOOR_PROTOCOL),
    });
    expect(s?.binaryType).toBe("arraybuffer");
    expect(terminalSocketUrl("http://localhost:8787/", ITEM, RUN)).toBe(
      `ws://localhost:8787/client/v1/terminal/${ITEM}/${RUN}`,
    );

    // The relay's frames reach the view: text as text, output as base64.
    s?.fire("open");
    s?.fire("message", { data: '{"t":"hello","mode":"type","viewers":1,"host":true}' });
    s?.fire("message", { data: new TextEncoder().encode("hi\x1b[0m").buffer });
    main.timer.run();
    expect(events).toEqual([
      { id: "view-0001", kind: "open" },
      {
        id: "view-0001",
        kind: "text",
        data: '{"t":"hello","mode":"type","viewers":1,"host":true}',
      },
      { id: "view-0001", kind: "bytes", base64: Buffer.from("hi\x1b[0m").toString("base64") },
    ]);

    // The view's frames go out as they are; nothing too big.
    expect(terminals.send({ id: "view-0001", data: '{"t":"input","data":"y"}' })).toEqual({
      ok: true,
    });
    expect(terminals.send({ id: "view-0001", data: "x".repeat(40_000) })).toEqual({ ok: false });
    expect(terminals.send({ id: "nope-0001", data: "x" })).toEqual({ ok: false });
    expect(s?.sent).toEqual(['{"t":"input","data":"y"}']);

    // The relay closing reaches the view once.
    s?.fire("close", { code: 1000, reason: "the session ended" });
    expect(events.at(-1)).toEqual({
      id: "view-0001",
      kind: "close",
      code: 1000,
      reason: "the session ended",
    });
    expect(terminals.count).toBe(0);
  });

  it("refuses bad ids, a duplicate handle, too many sockets and no sign-in; sign-out closes them all", () => {
    const { terminals, sockets } = mainProcess();
    expect(terminals.open({ id: "view-0001", workItemId: "wi_../../x", runId: RUN }).ok).toBe(
      false,
    );
    expect(terminals.open({ id: "view-0001", workItemId: ITEM, runId: "run_1/../ops" }).ok).toBe(
      false,
    );
    expect(terminals.open({ id: "../x", workItemId: ITEM, runId: RUN }).ok).toBe(false);
    for (let i = 0; i < TERMINAL_SOCKETS_MAX; i++) {
      expect(terminals.open({ id: `view-000${i}`, workItemId: ITEM, runId: RUN }).ok).toBe(true);
    }
    expect(terminals.open({ id: "view-0000", workItemId: ITEM, runId: RUN }).error).toBe(
      "already open",
    );
    expect(terminals.open({ id: "view-0009", workItemId: ITEM, runId: RUN }).error).toMatch(
      /Too many/,
    );
    terminals.closeAll();
    expect(terminals.count).toBe(0);
    expect(sockets.every((s) => s.closedWith === 1000)).toBe(true);

    const signedOut = mainProcess(null);
    expect(signedOut.terminals.open({ id: "view-0001", workItemId: ITEM, runId: RUN })).toEqual({
      ok: false,
      error: "Sign in to open the terminal.",
    });
    expect(signedOut.sockets).toHaveLength(0);
  });

  it("puts no token in the RPC's terminal messages", () => {
    const src = readFileSync(new URL("../src/shared/rpc.ts", import.meta.url), "utf8");
    const terminal = src.slice(src.indexOf("export type TerminalEvent"));
    expect(terminal.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
      /\b(token|authorization|bearer|ticket)\b/i,
    );
  });
});

describe("a terminal the door refuses as too old (ADR 0393)", () => {
  const tooOld: Door = () =>
    Response.json({ error: "too old", code: "update_required", minProtocol: 2 }, { status: 426 });

  it("closes with Update required and tells the app, as the live socket does", async () => {
    const main = mainProcess("sfd_secret", tooOld);
    main.terminals.open({ id: "view-0001", workItemId: ITEM, runId: RUN });
    // The upgrade is refused: the socket closes without ever opening.
    main.sockets[0]?.fire("close", { code: 1006, reason: "" });
    await settle();
    // The same URL over plain HTTP, with the same protocol headers.
    expect(main.asked).toEqual([
      {
        url: `https://sf-engine.example/client/v1/terminal/${ITEM}/${RUN}`,
        headers: {
          authorization: "Bearer sfd_secret",
          "x-sf-client": "desktop",
          "x-sf-client-protocol": String(DOOR_PROTOCOL),
        },
      },
    ]);
    expect(main.events).toEqual([{ id: "view-0001", kind: "close", ...UPDATE_REQUIRED }]);
    expect(main.updateRequired).toBe(1);
    expect(main.terminals.count).toBe(0);
  });

  it("passes any other refusal through as it came, and doesn't ask after an open", async () => {
    const main = mainProcess();
    main.terminals.open({ id: "view-0001", workItemId: ITEM, runId: RUN });
    main.sockets[0]?.fire("close", { code: 1006, reason: "" });
    await settle();
    expect(main.events).toEqual([{ id: "view-0001", kind: "close", code: 1006, reason: "" }]);
    expect(main.updateRequired).toBe(0);

    main.terminals.open({ id: "view-0002", workItemId: ITEM, runId: RUN });
    main.sockets[1]?.fire("open");
    main.sockets[1]?.fire("close", { code: 1000, reason: "the session ended" });
    expect(main.asked).toHaveLength(1);
  });

  it("lets the view's own close win while the door is asked", async () => {
    const main = mainProcess("sfd_secret", tooOld);
    main.terminals.open({ id: "view-0001", workItemId: ITEM, runId: RUN });
    main.sockets[0]?.fire("close", { code: 1006, reason: "" });
    main.terminals.close({ id: "view-0001" });
    await settle();
    expect(main.events).toEqual([{ id: "view-0001", kind: "close", code: 1000, reason: "" }]);
    expect(main.updateRequired).toBe(0);
  });
});

describe("the main process's terminals across a view reload", () => {
  it("closes every socket when the view (re)loads, so a reload never runs out of terminals", () => {
    const { terminals, sockets } = mainProcess();
    for (let reload = 0; reload < 5; reload++) {
      for (let i = 0; i < TERMINAL_SOCKETS_MAX; i++) {
        expect(
          terminals.open({ id: `view-${reload}-${i}00`, workItemId: ITEM, runId: RUN }).ok,
        ).toBe(true);
      }
      // What index.ts does on dom-ready.
      terminals.closeAll();
      expect(terminals.count).toBe(0);
    }
    expect(sockets).toHaveLength(5 * TERMINAL_SOCKETS_MAX);
    expect(sockets.every((s) => s.closedWith === 1000)).toBe(true);
  });

  it("is wired to the view's dom-ready, as well as sign-out and the window closing", () => {
    const src = readFileSync(new URL("../src/bun/index.ts", import.meta.url), "utf8");
    const domReady = src.slice(src.indexOf('on("dom-ready"'));
    expect(domReady.slice(0, domReady.indexOf("});"))).toContain("terminals.closeAll()");
    expect(src.match(/terminals\.closeAll\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the pane's output on its way to the view", () => {
  it("goes as one event per frame, after the status before it and before the close", () => {
    const { terminals, sockets, events, timer } = mainProcess();
    terminals.open({ id: "view-0001", workItemId: ITEM, runId: RUN });
    const s = sockets[0];
    s?.fire("open");
    for (const part of ["a", "b", "c"]) s?.fire("message", { data: Buffer.from(part) });
    expect(timer.waiting).toBe(1);
    expect(events.filter((e) => e.kind === "bytes")).toHaveLength(0);
    timer.run();
    expect(events.at(-1)).toEqual({
      id: "view-0001",
      kind: "bytes",
      base64: Buffer.from("abc").toString("base64"),
    });
    // A status message doesn't overtake output before it; nor does the close.
    s?.fire("message", { data: Buffer.from("d") });
    s?.fire("message", { data: '{"t":"viewers","viewers":2}' });
    s?.fire("message", { data: Buffer.from("e") });
    s?.fire("close", { code: 1000, reason: "the session ended" });
    expect(events.slice(-4).map((e) => e.kind)).toEqual(["bytes", "text", "bytes", "close"]);
    timer.run();
    expect(events.at(-1)?.kind).toBe("close");
  });

  it("closes the socket, not memory, when more waits than the bound", () => {
    const { terminals, sockets, events, timer } = mainProcess();
    terminals.open({ id: "view-0001", workItemId: ITEM, runId: RUN });
    const s = sockets[0];
    s?.fire("open");
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let i = 0; i <= OUTPUT_PENDING_MAX / chunk.byteLength; i++)
      s?.fire("message", { data: chunk });
    expect(terminals.count).toBe(0);
    expect(s?.closedWith).toBe(4000);
    expect(events.at(-1)).toEqual({ id: "view-0001", kind: "close", ...FELL_BEHIND });
    // Nothing more goes to the view for it.
    s?.fire("message", { data: chunk });
    timer.run();
    expect(events.at(-1)?.kind).toBe("close");
  });
});
