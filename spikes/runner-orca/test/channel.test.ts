import { describe, expect, it } from "vitest";
import {
  handleRunnerCall,
  memoryIdempotencyStore,
  runnerChannelKey,
  signRunnerRequest,
  verifyRunnerRequest,
} from "../src/contract/channel.ts";

const MASTER = "master-secret";
const RUNNER = "r_macmini01";
const now = new Date("2026-11-11T00:00:00Z");

async function signed(
  opts: { body?: string; key?: string; at?: Date; idem?: string; path?: string } = {},
) {
  const body = opts.body ?? JSON.stringify({ hello: "world" });
  const path = opts.path ?? "/runner/v1/claim";
  const key = opts.key ?? (await runnerChannelKey(MASTER, RUNNER));
  const headers = await signRunnerRequest({
    key,
    runner: RUNNER,
    method: "POST",
    path,
    body,
    idempotencyKey: opts.idem ?? "claim:r_macmini01:abc12345",
    now: opts.at ?? now,
  });
  return new Request(`https://factory.example${path}`, { method: "POST", headers, body });
}

const keyFor = (runner: string) => runnerChannelKey(MASTER, runner);

describe("signed runner channel", () => {
  it("accepts a correctly signed request", async () => {
    const result = await verifyRunnerRequest(await signed(), keyFor, { now });
    expect(result).toMatchObject({ ok: true, runner: RUNNER });
  });

  it("refuses a request more than 5 minutes off", async () => {
    const at = new Date(now.getTime() - 301_000);
    const result = await verifyRunnerRequest(await signed({ at }), keyFor, { now });
    expect(result).toMatchObject({ ok: false, reason: "stale request" });
  });

  it("accepts a request just inside the window", async () => {
    const at = new Date(now.getTime() - 299_000);
    expect((await verifyRunnerRequest(await signed({ at }), keyFor, { now })).ok).toBe(true);
  });

  it("refuses a tampered body, path or idempotency key", async () => {
    const original = await signed();
    const headers = new Headers(original.headers);
    const tampered = new Request(original.url, { method: "POST", headers, body: '{"hello":"x"}' });
    expect(await verifyRunnerRequest(tampered, keyFor, { now })).toMatchObject({
      reason: "bad signature",
    });
    const otherPath = new Request("https://factory.example/runner/v1/heartbeat", {
      method: "POST",
      headers,
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await verifyRunnerRequest(otherPath, keyFor, { now })).toMatchObject({
      reason: "bad signature",
    });
    headers.set("x-sf-idempotency-key", "claim:r_macmini01:other999");
    const otherKey = new Request(original.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await verifyRunnerRequest(otherKey, keyFor, { now })).toMatchObject({
      reason: "bad signature",
    });
  });

  it("refuses another runner's key", async () => {
    const key = await runnerChannelKey(MASTER, "r_laptop0001");
    expect(await verifyRunnerRequest(await signed({ key }), keyFor, { now })).toMatchObject({
      reason: "bad signature",
    });
  });

  it("refuses an unknown runner and an unsigned request", async () => {
    expect(await verifyRunnerRequest(await signed(), async () => null, { now })).toMatchObject({
      reason: "unknown runner",
    });
    const bare = new Request("https://factory.example/runner/v1/claim", { method: "POST" });
    expect(await verifyRunnerRequest(bare, keyFor, { now })).toMatchObject({
      reason: "unsigned request",
    });
  });
});

describe("idempotent calls", () => {
  it("runs the handler once per idempotency key and replays the stored answer", async () => {
    const store = memoryIdempotencyStore();
    let runs = 0;
    const handler = async () => ({ job: `job-${++runs}` });
    const first = await handleRunnerCall(await signed(), { keyFor, store, now }, handler);
    const again = await handleRunnerCall(await signed(), { keyFor, store, now }, handler);
    expect(await first.json()).toEqual({ job: "job-1" });
    expect(await again.json()).toEqual({ job: "job-1" });
    expect(again.headers.get("x-sf-replayed")).toBe("1");
    expect(runs).toBe(1);
  });

  it("refuses the same key with a different body", async () => {
    const store = memoryIdempotencyStore();
    const handler = async () => ({ ok: true });
    await handleRunnerCall(await signed(), { keyFor, store, now }, handler);
    const clash = await handleRunnerCall(
      await signed({ body: '{"hello":"other"}' }),
      { keyFor, store, now },
      handler,
    );
    expect(clash.status).toBe(409);
  });

  it("answers 401 before touching the store", async () => {
    const store = memoryIdempotencyStore();
    const at = new Date(now.getTime() - 3_600_000);
    const response = await handleRunnerCall(
      await signed({ at }),
      { keyFor, store, now },
      async () => {
        throw new Error("must not run");
      },
    );
    expect(response.status).toBe(401);
  });
});
