// The runner host's web terminal (spec 35, ADR 0440): the relay client against a scripted socket,
// with the adapter's bridge faked, and the held `terminal` call wired into runJob.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  RESULT_FILE,
  TERMINAL_HIGH_WATER,
  TERMINAL_HOST_FRAME,
} from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { runJob } from "../src/job.ts";
import { relayTerminal } from "../src/terminal.ts";
import {
  controlPlane,
  FakeSocket,
  fakeAdapter,
  fakeCloud,
  fakeTerminal,
  git,
  job,
  scratchRepo,
} from "./helpers.ts";

async function until(what: string, test: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function relay(options: { signal?: AbortSignal } = {}) {
  const terminal = fakeTerminal();
  let socket: FakeSocket | null = null;
  const logs: string[] = [];
  const done = relayTerminal({
    url: "wss://engine.invalid/terminal/v1/jobs/job_1/host?ticket=x",
    open: (o) => terminal.open(o),
    signal: options.signal ?? new AbortController().signal,
    log: (m) => logs.push(m),
    connect: (url) => {
      socket = new FakeSocket(url);
      return socket;
    },
    flushMs: 5,
  });
  if (!socket) throw new Error("no socket");
  return { terminal, ws: socket as FakeSocket, done, logs };
}

describe("the host's relay client", () => {
  it("opens the bridge when the relay says so, relays both ways and stops when told", async () => {
    const { terminal, ws, done } = relay();
    expect(ws.binaryType).toBe("arraybuffer");
    ws.relay({ t: "open", size: { cols: 120, rows: 40 } });
    await until("bridge opened", () => terminal.opened.length === 1);
    expect(terminal.opened[0]?.size).toEqual({ cols: 120, rows: 40 });
    await until("first screen", () => ws.bytes().length > 0);
    expect(ws.texts()).toContainEqual({ t: "size", size: { cols: 80, rows: 24 } });
    expect(ws.bytes()).toEqual(["screen"]);

    // Small writes are coalesced into one frame.
    for (const piece of ["a", "b", "c"])
      terminal.opened[0]?.onOutput(new TextEncoder().encode(piece));
    await until("coalesced", () => ws.bytes().length === 2);
    expect(ws.bytes()[1]).toBe("abc");

    ws.relay({ t: "input", data: "\x1b[A" });
    ws.relay({ t: "resize", size: { cols: 90, rows: 20 } });
    ws.relay({ t: "redraw" });
    await until("redraw", () => terminal.redraws === 1);
    expect(terminal.writes).toEqual(["\x1b[A"]);
    expect(terminal.resizes).toEqual([{ cols: 90, rows: 20 }]);
    // A malformed message is ignored.
    ws.emit("message", "{not json");

    ws.relay({ t: "close", reason: "nobody is watching" });
    await done;
    expect(terminal.closes).toBe(1);
    expect(ws.closed?.code).toBe(1000);
  });

  it("splits big output into frames of at most 32 KiB", async () => {
    const { terminal, ws } = relay();
    ws.relay({ t: "open", size: null });
    await until("first screen", () => ws.bytes().length === 1);
    terminal.opened[0]?.onOutput(new Uint8Array(TERMINAL_HOST_FRAME * 2 + 10).fill(0x41));
    await until("frames", () => ws.bytes().length >= 4);
    const sizes = ws.sent.filter((s) => typeof s !== "string").map((s) => s.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TERMINAL_HOST_FRAME);
    expect(sizes.slice(1)).toEqual([TERMINAL_HOST_FRAME, TERMINAL_HOST_FRAME, 10]);
    ws.close();
  });

  it("drops output while the socket is backed up and redraws once it drains", async () => {
    const { terminal, ws } = relay();
    ws.relay({ t: "open", size: null });
    await until("first screen", () => ws.bytes().length === 1);
    ws.bufferedAmount = TERMINAL_HIGH_WATER + 1;
    terminal.opened[0]?.onOutput(new TextEncoder().encode("lost"));
    await sleep(30);
    expect(ws.bytes()).toEqual(["screen"]);
    ws.bufferedAmount = 0;
    await until("redrawn", () => ws.bytes().includes("redrawn"));
    expect(terminal.redraws).toBe(1);
    expect(ws.bytes()).not.toContain("lost");
    ws.close();
  });

  it("tells the relay when the session ends, and when the job stops", async () => {
    const { terminal, ws, done } = relay();
    ws.relay({ t: "open", size: null });
    await until("bridge opened", () => terminal.opened.length === 1);
    terminal.opened[0]?.onExit("the session ended");
    await done;
    expect(ws.texts().at(-1)).toEqual({ t: "ended", reason: "the session ended" });
    expect(ws.closed).not.toBeNull();

    const stop = new AbortController();
    const second = relay({ signal: stop.signal });
    second.ws.relay({ t: "open", size: null });
    await until("bridge opened", () => second.terminal.opened.length === 1);
    stop.abort();
    await second.done;
    expect(second.ws.texts().at(-1)).toEqual({ t: "ended", reason: "the session ended" });
    expect(second.terminal.closes).toBe(1);
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function world() {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  const cloud = fakeCloud();
  const cp = await controlPlane(cloud);
  return { repo, cloud, cp };
}

const finish = async (wt: string) => {
  await writeFile(join(wt, "README.md"), "# scratch\nline\n");
  git(wt, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "add a line");
  await writeFile(join(wt, RESULT_FILE), JSON.stringify({ notes: "added" }));
  return [{ type: "session.ended" as const, outcome: "completed" as const, summary: "done" }];
};

describe("runJob and the web terminal", () => {
  it("connects when someone opens the terminal, and closes it when the session ends", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.claims.set("c", j);
    cloud.terminalUrls.set(j.jobId, ["wss://engine.invalid/terminal/v1/jobs/x/host?ticket=t"]);
    const sockets: FakeSocket[] = [];
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt, _j, signal) => {
        for (let i = 0; i < 300 && adapter.terminal.opened.length === 0 && !signal.aborted; i++) {
          await sleep(10);
        }
        return finish(wt);
      },
      { terminal: true },
    );
    const report = await runJob({
      adapter,
      cp,
      git: repo.host,
      job: j,
      flushMs: 5,
      connectTerminal: (url) => {
        const ws = new FakeSocket(url);
        sockets.push(ws);
        // The relay greets the host at once.
        queueMicrotask(() => ws.relay({ t: "open", size: null }));
        return ws;
      },
    });
    expect(report.outcome).toBe("completed");
    expect(adapter.terminal.opened).toHaveLength(1);
    expect(sockets[0]?.url).toContain("ticket=t");
    expect(sockets[0]?.texts().at(-1)).toEqual({ t: "ended", reason: "the session ended" });
    expect(adapter.terminal.closes).toBe(1);
    expect(cloud.terminalCalls).toBeGreaterThan(0);
  });

  it("stops asking when the engine doesn't know the call, and never asks without the capability", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.claims.set("c", j);
    cloud.noTerminalCall = true;
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt) => {
        await sleep(100);
        return finish(wt);
      },
      { terminal: true },
    );
    const report = await runJob({ adapter, cp, git: repo.host, job: j, flushMs: 5 });
    expect(report.outcome).toBe("completed");
    expect(report.handedBack).toBe(true);
    expect(cloud.terminalCalls).toBe(1);

    const other = await world();
    const k = job();
    other.cloud.claims.set("c", k);
    const plain = fakeAdapter((x) => other.repo.host.clonePath(x), finish);
    await runJob({ adapter: plain, cp: other.cp, git: other.repo.host, job: k, flushMs: 5 });
    expect(other.cloud.terminalCalls).toBe(0);
  });
});
