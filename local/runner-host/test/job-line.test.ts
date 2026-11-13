// The job line on the host's side (spec 44 part B, ADR 0592): opened when both sides declare it,
// a push wakes the matching loop (and is never lost while the loop is making its call), a 404 engine
// leaves it down (held calls), a ping without a pong reopens it, and the steer loop calls without
// holding while it is up.
import {
  ChannelCallError,
  type ControlPlaneClient,
  type Job,
  STEER_WAIT_MAX_MS,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { steerLoop } from "../src/job.ts";
import { JobLine } from "../src/job-line.ts";

const job = { jobId: "job_1", lease: { fencingToken: 3 } } as unknown as Job;

/** A WebSocket the test drives. */
class FakeSocket extends EventTarget {
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  push(t: string) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ t }) }));
  }
  pong() {
    this.dispatchEvent(Object.assign(new Event("message"), { data: "pong" }));
  }
}

function setup(options: { line?: () => Promise<{ connect: { url: string } }> } = {}) {
  const sockets: FakeSocket[] = [];
  const calls: { waitMs?: number }[] = [];
  const cp = {
    line: options.line ?? (async () => ({ connect: { url: "wss://engine/line?ticket=x" } })),
    steers: async (_id: string, body: { waitMs?: number }) => {
      calls.push(body);
      return { steers: [] };
    },
  } as unknown as ControlPlaneClient;
  const stop = new AbortController();
  const line = new JobLine({
    cp,
    job,
    signal: stop.signal,
    log: () => {},
    engineHasLine: () => true,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      queueMicrotask(() => s.open());
      return s as unknown as WebSocket;
    },
    timings: { pingMs: 20, pongMs: 30, retryMs: 5, unavailableMs: 50 },
  });
  return { cp, line, sockets, calls, stop, running: line.run() };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("the job line (spec 44 part B)", () => {
  it("opens, and a push wakes the loop waiting for it; a push mid-call isn't lost", async () => {
    const { line, sockets, stop, running } = setup();
    for (let i = 0; i < 50 && !line.up(); i++) await tick(2);
    expect(line.up()).toBe(true);
    const waiting = line.next("steer", stop.signal, 60_000);
    sockets[0]?.push("steer");
    await waiting;
    // No loop waiting (it is making its call): the next wait returns at once.
    sockets[0]?.push("viewer");
    await line.next("viewer", stop.signal, 60_000);
    stop.abort();
    await running;
  });

  it("stays down against an engine without it (404): the loops keep their held calls", async () => {
    const { line, stop, running } = setup({
      line: async () => {
        throw new ChannelCallError("/runner/v1/jobs/job_1/line", 404, "not_found", "no");
      },
    });
    await tick(20);
    expect(line.up()).toBe(false);
    stop.abort();
    await running;
  });

  it("reopens a line whose ping gets no pong (half-open)", async () => {
    const { line, sockets, stop, running } = setup();
    for (let i = 0; i < 50 && !line.up(); i++) await tick(2);
    // Pings go out; no pong comes back: within ping + pong time the line is closed and reopened.
    for (let i = 0; i < 100 && sockets.length < 2; i++) await tick(5);
    expect(sockets[0]?.sent).toContain("ping");
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    // Answered pongs keep a line open.
    const second = sockets.at(-1) as FakeSocket;
    for (let i = 0; i < 10; i++) {
      second.pong();
      await tick(10);
    }
    stop.abort();
    await running;
  });

  it("the steer loop calls without holding while the line is up, and holds without it", async () => {
    const { cp, line, sockets, calls, stop, running } = setup();
    const adapter = {
      steer: async () => {},
      manifest: async () => ({ capabilities: ["steer"] }),
    } as never;
    for (let i = 0; i < 50 && !line.up(); i++) await tick(2);
    const loop = steerLoop({
      adapter,
      cp,
      job,
      signal: stop.signal,
      steer: async () => {},
      push: async () => {},
      onStop: () => {},
      log: () => {},
      line,
    });
    await tick(10);
    expect(calls).toEqual([{ fencingToken: 3, waitMs: 0 }]);
    sockets[0]?.push("steer");
    for (let i = 0; i < 50 && calls.length < 2; i++) await tick(2);
    expect(calls[1]).toEqual({ fencingToken: 3, waitMs: 0 });
    stop.abort();
    await Promise.all([loop, running]);

    // Without a line: the held call, as before.
    const held: { waitMs?: number }[] = [];
    const quiet = new AbortController();
    const done = steerLoop({
      adapter,
      cp: {
        steers: async (_id: string, body: { waitMs?: number }) => {
          held.push(body);
          quiet.abort();
          return { steers: [] };
        },
      } as unknown as ControlPlaneClient,
      job,
      signal: quiet.signal,
      steer: async () => {},
      push: async () => {},
      onStop: () => {},
      log: () => {},
    });
    await done;
    expect(held[0]?.waitMs).toBe(STEER_WAIT_MAX_MS);
  });
});
