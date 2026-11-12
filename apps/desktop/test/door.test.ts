// The door client against a fake door: calls carry the token, a gate decision asks for a challenge
// bound to the op and the canonical input digest, signs it, then calls with the proof. And the
// digest rule agrees with core's, which the server checks: both test suites pin the same vector
// (apps/engine/test/desktop.test.ts).
import { describe, expect, it } from "vitest";
import { canonicalJson, inputDigest, presenceMessage } from "../src/bun/digest.ts";

/** The shared vector: core's inputDigest of { b: [1, { d: undefined, c: "x" }], a: null }. */
const DIGEST_VECTOR = "48aa8d7ca4745dc18af09c1efd1d919435cf93ad6aac93632f0e3cb043fae4f4";

import { nextRestart } from "../src/bun/backoff.ts";
import { Door, type Fetch, UnauthenticatedError } from "../src/bun/door.ts";
import { pkcePair } from "../src/bun/pkce.ts";

function fakeDoor(
  answer: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown },
) {
  const seen: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const f: Fetch = async (url, init) => {
    const path = url.replace(/^.*\/client\/v1\//, "");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = init.headers as Record<string, string>;
    seen.push({ path, body, auth: headers.authorization ?? null });
    const a = answer(path, body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  };
  return { f, seen };
}

describe("the door client", () => {
  it("calls with the bearer token and turns 401 into UnauthenticatedError", async () => {
    const { f, seen } = fakeDoor(() => ({ json: { result: { ok: 1 } } }));
    const door = new Door("https://engine.example/", () => "sfd_t", f);
    expect(await door.call("inbox.list", {})).toEqual({ ok: true, result: { ok: 1 } });
    expect(seen[0]).toMatchObject({
      path: "call",
      auth: "Bearer sfd_t",
      body: { op: "inbox.list" },
    });

    const revoked = new Door(
      "https://e",
      () => "sfd_t",
      fakeDoor(() => ({ status: 401, json: {} })).f,
    );
    await expect(revoked.call("inbox.list", {})).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(
      new Door("https://e", () => null, f).call("inbox.list", {}),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("decides a gate with a proof for exactly that op and input, signing the engine's summary", async () => {
    const input = { workItemId: "wi_1", openedFullDiff: true };
    const digest = await inputDigest(input);
    const summary = 'Merge #1 "Fix it" into main';
    const { f, seen } = fakeDoor((_p, body) =>
      body.op === "presence.challenge"
        ? {
            json: {
              result: { challengeId: "prc_1", nonce: "n0nce", inputDigest: digest, summary },
            },
          }
        : { json: { result: { merged: true } } },
    );
    const signed: string[] = [];
    const door = new Door("https://e", () => "sfd_t", f);
    const res = await door.decide("review.merge", input, async (message) => {
      signed.push(message);
      return "c2ln";
    });
    expect(res).toEqual({ ok: true, result: { merged: true } });
    expect(seen[0]?.body).toEqual({
      op: "presence.challenge",
      input: { op: "review.merge", input },
    });
    expect(signed).toEqual([`n0nce\nreview.merge\n${digest}\n${summary}`]);
    expect(seen[1]?.body).toEqual({
      op: "review.merge",
      input,
      presence: { challengeId: "prc_1", nonce: "n0nce", signature: "c2ln" },
    });
  });

  it("won't sign when the engine digested a different input", async () => {
    const { f, seen } = fakeDoor(() => ({
      json: {
        result: { challengeId: "prc_1", nonce: "n", inputDigest: "0".repeat(64), summary: "x" },
      },
    }));
    let asked = false;
    const res = await new Door("https://e", () => "t", f).decide(
      "spec.approve",
      { workItemId: "wi_1" },
      async () => {
        asked = true;
        return "sig";
      },
    );
    expect(res).toMatchObject({ ok: false, code: "conflict" });
    expect(asked).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("a cancelled Touch ID makes no decision call", async () => {
    const input = { workItemId: "wi_1" };
    const digest = await inputDigest(input);
    const { f, seen } = fakeDoor(() => ({
      json: {
        result: { challengeId: "prc_1", nonce: "n", inputDigest: digest, summary: "Approve" },
      },
    }));
    const res = await new Door("https://e", () => "t", f).decide(
      "spec.approve",
      input,
      async () => {
        throw new Error("Touch ID was cancelled");
      },
    );
    expect(res).toMatchObject({ ok: false, code: "cancelled" });
    expect(seen.map((s) => s.body.op)).toEqual(["presence.challenge"]);
  });

  it("digests the same way as core", async () => {
    const value = { b: [1, { d: undefined, c: "x" }], a: null };
    expect(canonicalJson(value)).toBe('{"a":null,"b":[1,{"c":"x"}]}');
    expect(await inputDigest(value)).toBe(DIGEST_VECTOR);
    expect(presenceMessage("n", "op", "d", "s")).toBe("n\nop\nd\ns");
  });
});

describe("PKCE and backoff", () => {
  it("makes an S256 pair", async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("doubles to 30 s and resets after a healthy minute", () => {
    expect(nextRestart(0, 100)).toEqual({ restarts: 1, delayMs: 1000 });
    expect(nextRestart(3, 100)).toEqual({ restarts: 4, delayMs: 8000 });
    expect(nextRestart(9, 100).delayMs).toBe(30_000);
    expect(nextRestart(9, 61_000)).toEqual({ restarts: 1, delayMs: 1000 });
  });
});
