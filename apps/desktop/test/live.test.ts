// The live socket and the version handshake (ADR 0393): a refused upgrade shows "Update required"
// and isn't retried; any other failure reconnects with backoff.
import { describe, expect, it } from "vitest";
import { httpUrl, Live, refusedAsTooOld } from "../src/bun/live.ts";

/** A socket that never opens: it closes as Bun's does when the upgrade is refused. */
function refusedSocket() {
  const listeners: Record<string, (() => void)[]> = {};
  const ws = {
    readyState: 3,
    addEventListener: (t: string, fn: () => void) => {
      listeners[t] = [...(listeners[t] ?? []), fn];
    },
    close: () => {},
    send: () => {},
  };
  queueMicrotask(() => {
    for (const fn of listeners.error ?? []) fn();
    for (const fn of listeners.close ?? []) fn();
  });
  return ws as unknown as WebSocket;
}

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("the live socket's handshake", () => {
  it("asks over https, with the same headers", async () => {
    expect(httpUrl("wss://engine.example/client/v1/live")).toBe(
      "https://engine.example/client/v1/live",
    );
    let seen: Headers | null = null;
    const f = (async (_u: string, init: RequestInit) => {
      seen = new Headers(init.headers);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await refusedAsTooOld("wss://e/x", { "x-sf-client-protocol": "1" }, f);
    expect((seen as Headers | null)?.get("x-sf-client-protocol")).toBe("1");
  });

  it("a 426 update_required shows Update required and stops reconnecting", async () => {
    let required = 0;
    const timers: number[] = [];
    const live = new Live(
      "wss://e/client/v1/live",
      () => "tok",
      { connected: () => {}, event: () => {}, updateRequired: () => required++ },
      {
        socket: refusedSocket,
        fetch: answer(426, { code: "update_required" }),
        setTimeout: (_fn, ms) => timers.push(ms),
      },
    );
    live.start();
    await settle();
    expect(required).toBe(1);
    expect(timers).toEqual([]);
  });

  it("any other refusal reconnects with backoff", async () => {
    let required = 0;
    const timers: number[] = [];
    const live = new Live(
      "wss://e/client/v1/live",
      () => "tok",
      { connected: () => {}, event: () => {}, updateRequired: () => required++ },
      {
        socket: refusedSocket,
        fetch: answer(502, { error: "bad gateway" }),
        setTimeout: (_fn, ms) => timers.push(ms),
      },
    );
    live.start();
    await settle();
    expect(required).toBe(0);
    expect(timers).toHaveLength(1);
  });
});
