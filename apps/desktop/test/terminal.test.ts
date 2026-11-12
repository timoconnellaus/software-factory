// The desktop's web terminal (spec 42, ADR 0530): the main process's socket on the client door (the
// token only in its Authorization header, ids checked, a cap on open sockets, sign-out closes them),
// the view's socket over the RPC driving the shared TerminalClient (the owner's keys go out, a
// watcher's never do), and the button's and the fallback's rules.
import { readFileSync } from "node:fs";
import type { WorkItemDetail } from "@software-factory/client/ops";
import { TerminalClient, type TerminalStatus } from "@software-factory/client/web-terminal";
import { describe, expect, it } from "vitest";
import {
  type DoorSocket,
  FELL_BEHIND,
  OUTPUT_PENDING_MAX,
  TERMINAL_SOCKETS_MAX,
  Terminals,
  terminalSocketUrl,
} from "../src/bun/terminal.ts";
import {
  closesDock,
  fallbackLine,
  RUNNER_WAIT_MS,
  terminalOf,
} from "../src/mainview/lib/terminal.ts";
import {
  RpcTerminalSocket,
  type TerminalRpc,
  VIEW_PENDING_MAX,
} from "../src/mainview/lib/terminal-socket.ts";
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

function mainProcess(token: string | null = "sfd_secret") {
  const events: TerminalEvent[] = [];
  const sockets: FakeSocket[] = [];
  const timer = frames();
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
  );
  return { terminals, events, sockets, timer };
}

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
    expect(s?.headers).toEqual({ authorization: "Bearer sfd_secret" });
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

  it("is drawn once per frame in the view, and a hidden view's backlog closes it with Reconnect", async () => {
    const { main, rpc, frame } = wired();
    const ws = new RpcTerminalSocket(rpc, ITEM, RUN, "view-0001", frame.schedule);
    const term = screen();
    const statuses: TerminalStatus[] = [];
    new TerminalClient(ws, term, (s) => statuses.push(s));
    await tick();
    const door = main.sockets[0];
    door?.fire("open");
    door?.fire("message", {
      data: JSON.stringify({ t: "hello", mode: "watch", viewers: 1, host: true }),
    });
    door?.fire("message", { data: Buffer.from("one ") });
    main.timer.run();
    door?.fire("message", { data: Buffer.from("two") });
    main.timer.run();
    expect(term.writes).toEqual([]);
    frame.run();
    expect(term.writes).toEqual(["one two"]);

    // No frames (a hidden window): the backlog is bounded, then the socket closes.
    const big = Buffer.alloc(512 * 1024, 120);
    for (let i = 0; i <= VIEW_PENDING_MAX / big.byteLength; i++) {
      door?.fire("message", { data: big });
      main.timer.run();
    }
    await tick();
    expect(ws.readyState).toBe(3);
    expect(statuses.at(-1)).toMatchObject({ phase: "closed" });
    expect(door?.closedWith).not.toBeNull();
    expect(main.terminals.count).toBe(0);
    frame.run();
    expect(term.writes).toEqual(["one two"]);
  });
});

/** The RPC between the view and a main process whose door sockets are fakes. */
function wired() {
  const main = mainProcess();
  const listeners = new Set<(e: TerminalEvent) => void>();
  main.events.push = (...events: TerminalEvent[]) => {
    for (const e of events) for (const l of listeners) l(e);
    return 0;
  };
  const rpc: TerminalRpc = {
    open: async (p) => main.terminals.open(p),
    send: async (p) => main.terminals.send(p),
    close: async (p) => main.terminals.close(p),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return { main, rpc, frame: frames() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function screen() {
  const writes: string[] = [];
  const sizes: [number, number][] = [];
  return {
    writes,
    sizes,
    write: (d: string | Uint8Array) =>
      writes.push(typeof d === "string" ? d : new TextDecoder().decode(d)),
    resize: (c: number, r: number) => sizes.push([c, r]),
  };
}

describe("the view's terminal socket over the RPC", () => {
  it("lets the shared client draw the relay's output and send the owner's keys", async () => {
    const { main, rpc, frame } = wired();
    const ws = new RpcTerminalSocket(rpc, ITEM, RUN, "view-0001", frame.schedule);
    const term = screen();
    const statuses: TerminalStatus[] = [];
    const client = new TerminalClient(ws, term, (s) => statuses.push(s));
    await tick();
    const door = main.sockets[0];
    if (!door) throw new Error("no socket");
    door.fire("open");
    expect(ws.readyState).toBe(1);
    door.fire("message", {
      data: JSON.stringify({ t: "hello", mode: "type", viewers: 1, host: true }),
    });
    door.fire("message", { data: new TextEncoder().encode("\x1b[32mready\x1b[0m").buffer });
    main.timer.run();
    frame.run();
    door.fire("message", { data: JSON.stringify({ t: "size", size: { cols: 100, rows: 30 } }) });
    expect(term.writes).toEqual(["\x1b[32mready\x1b[0m"]);
    expect(term.sizes).toEqual([[100, 30]]);
    expect(statuses.at(-1)).toMatchObject({ phase: "live", mode: "type" });

    client.type("y\r");
    client.fit(120, 40);
    await tick();
    expect(door.sent.map((s) => JSON.parse(s))).toEqual([
      { t: "input", data: "y\r" },
      { t: "resize", size: { cols: 120, rows: 40 } },
    ]);

    // Closing the view closes the door's socket; the session goes on (nothing else is sent).
    client.close();
    await tick();
    expect(door.closedWith).toBe(1000);
    expect(ws.readyState).toBe(3);
  });

  it("never sends a watcher's keys or size", async () => {
    const { main, rpc } = wired();
    const ws = new RpcTerminalSocket(rpc, ITEM, RUN, "view-0002");
    const client = new TerminalClient(ws, screen(), () => {});
    await tick();
    const door = main.sockets[0];
    door?.fire("open");
    door?.fire("message", {
      data: JSON.stringify({ t: "hello", mode: "watch", viewers: 2, host: true }),
    });
    client.type("rm -rf /\r");
    client.fit(80, 24);
    await tick();
    expect(door?.sent).toEqual([]);
  });

  it("reports a refused open as a close the client shows", async () => {
    const statuses: TerminalStatus[] = [];
    const rpc: TerminalRpc = {
      open: async () => ({ ok: false, error: "Sign in to open the terminal." }),
      send: async () => ({ ok: false }),
      close: async () => ({ ok: false }),
      subscribe: () => () => {},
    };
    const ws = new RpcTerminalSocket(rpc, ITEM, RUN, "view-0003");
    new TerminalClient(ws, screen(), (s) => statuses.push(s));
    await tick();
    expect(ws.readyState).toBe(3);
    expect(statuses.at(-1)).toMatchObject({ phase: "closed" });
  });
});

const run = (over: Partial<WorkItemDetail["runs"][number]>): WorkItemDetail["runs"][number] => ({
  id: RUN,
  jobId: "job_1",
  runNo: 1,
  stage: "build",
  runnerId: "rnr_1",
  branch: "factory/1",
  status: "running",
  outcome: null,
  summary: null,
  headSha: null,
  takeover: null,
  startedAt: "2026-11-12T00:00:00Z",
  endedAt: null,
  ...over,
});

describe("Open terminal's rules", () => {
  it("offers the newest live run of the stage, with or without a tmux hint", () => {
    const runs = [
      run({ id: "run_old", runNo: 1, endedAt: "2026-11-12T00:01:00Z" }),
      run({ id: "run_plan", runNo: 2, stage: "spec" }),
      run({ id: "run_build", runNo: 3 }),
    ];
    expect(terminalOf(runs)?.id).toBe("run_build");
    expect(terminalOf(runs, "spec")).toEqual({
      id: "run_plan",
      stage: "spec",
      runNo: 2,
      takeover: null,
    });
    expect(terminalOf([run({ endedAt: "2026-11-12T00:01:00Z" })])).toBeNull();
  });

  it("says why in one line only when the terminal can't be reached", () => {
    const live: TerminalStatus = { phase: "live", mode: "type", viewers: 1, message: null };
    const waiting: TerminalStatus = { ...live, phase: "waiting" };
    expect(fallbackLine({ allowed: true, reason: null }, live, 0)).toBeNull();
    expect(fallbackLine({ allowed: true, reason: null }, waiting, 1_000)).toBeNull();
    expect(fallbackLine({ allowed: true, reason: null }, waiting, RUNNER_WAIT_MS)).toMatch(
      /offline/,
    );
    expect(
      fallbackLine(
        { allowed: false, reason: "This runner can't share its terminal: update it." },
        live,
        0,
      ),
    ).toBe("This runner can't share its terminal: update it.");
    expect(
      fallbackLine(
        { allowed: true, reason: null },
        { phase: "closed", mode: null, viewers: 0, message: null },
        0,
      ),
    ).toMatch(/Couldn't reach/);
  });
});

describe("closing the terminal from the keyboard", () => {
  const key = (
    k: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });
  const at = (inTypingTerminal: boolean, overlayOpen = false) => ({
    inTypingTerminal,
    overlayOpen,
  });

  it("Esc closes it, except in a session you type into, where Esc is the session's", () => {
    expect(closesDock(key("Escape"), at(false))).toBe(true);
    expect(closesDock(key("Escape"), at(true))).toBe(false);
  });

  it("⌘Esc always closes it, so there is a keyboard-only way out of a typing session", () => {
    expect(closesDock(key("Escape", { metaKey: true }), at(true))).toBe(true);
    expect(closesDock(key("Escape", { metaKey: true }), at(false))).toBe(true);
    // Other chords and keys aren't it; ⌘W stays the tab's.
    expect(closesDock(key("w", { metaKey: true }), at(true))).toBe(false);
    expect(closesDock(key("Escape", { metaKey: true, shiftKey: true }), at(true))).toBe(false);
    // A dialog or popover gets its own Esc.
    expect(closesDock(key("Escape", { metaKey: true }), at(true, true))).toBe(false);
  });

  it("shows the chord next to Close", () => {
    const src = readFileSync(
      new URL("../src/mainview/components/terminal-panel.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("CLOSE_CHORD_LABEL");
    expect(src).toContain('data-testid="terminal-close-chord"');
  });
});
