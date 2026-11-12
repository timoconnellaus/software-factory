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
  TERMINAL_SOCKETS_MAX,
  Terminals,
  terminalSocketUrl,
} from "../src/bun/terminal.ts";
import { fallbackLine, RUNNER_WAIT_MS, terminalOf } from "../src/mainview/lib/terminal.ts";
import { RpcTerminalSocket, type TerminalRpc } from "../src/mainview/lib/terminal-socket.ts";
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

function mainProcess(token: string | null = "sfd_secret") {
  const events: TerminalEvent[] = [];
  const sockets: FakeSocket[] = [];
  const terminals = new Terminals(
    "https://sf-engine.example",
    () => token,
    (e) => events.push(e),
    (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  );
  return { terminals, events, sockets };
}

describe("the main process's terminal sockets", () => {
  it("opens the door's terminal socket with the token in Authorization, never in the URL", () => {
    const { terminals, sockets, events } = mainProcess();
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
  return { main, rpc };
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
    const { main, rpc } = wired();
    const ws = new RpcTerminalSocket(rpc, ITEM, RUN, "view-0001");
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
