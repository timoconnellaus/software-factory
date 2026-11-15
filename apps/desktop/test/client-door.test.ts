// The screens' operations end to end against a fake client door (spec 40 M3): the view's `read`,
// `op` and `decide` (src/mainview/lib/op.ts) through the main process's handlers
// (src/bun/operations.ts) and the door client (src/bun/door.ts). Touch ID can't run in a test, so
// the device key is a signer that counts its prompts: adding a phone signs exactly once.
import { beforeEach, describe, expect, it } from "vitest";
import { inputDigest } from "../src/bun/digest.ts";
import { Door, type Fetch } from "../src/bun/door.ts";
import { operationHandlers } from "../src/bun/operations.ts";
import { connect, decide, OpError, op, read } from "../src/mainview/lib/op.ts";

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

let seen: Seen[];
let prompts: string[];
let touchId: "approve" | "cancel";
let held: boolean;

const SUMMARY = "Add a phone to your account";
const OFFER = {
  offerId: "pof_1",
  pairUrl: "https://example/pair#s",
  code: "ABCDE12345",
  expiresAt: "2026-11-15T00:05:00Z",
};

const fakeFetch: Fetch = async (url, init) => {
  const path = url.replace(/^.*\/client\/v1\//, "");
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  seen.push({ path, body });
  const reply = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
  if (path === "batch") {
    const calls = body.calls as { op: string }[];
    return reply({ results: calls.map((c) => ({ ok: true, result: { op: c.op } })) });
  }
  if (body.op === "presence.challenge") {
    const asked = body.input as { op: string; input: unknown };
    return reply({
      result: {
        challengeId: "prc_1",
        nonce: "n0nce",
        inputDigest: await inputDigest(asked.input),
        summary: SUMMARY,
      },
    });
  }
  if (held) return reply({ pending: true, pendingActionId: "pa_1" }, 202);
  if (body.op === "mobile.pairOffer") {
    if (!body.presence) return reply({ error: "browser only", code: "forbidden" }, 403);
    return reply({ result: OFFER });
  }
  return reply({ result: { ok: true } });
};

beforeEach(() => {
  seen = [];
  prompts = [];
  touchId = "approve";
  held = false;
  connect(
    operationHandlers({
      door: () => new Door("https://engine.example", () => "sfd_t", fakeFetch),
      signer: () => async (message) => {
        prompts.push(message);
        if (touchId === "cancel") throw new Error("Touch ID was cancelled");
        return "c2ln";
      },
      signedOut: () => {},
    }),
  );
});

describe("the screens through the client door", () => {
  it("loads a page's reads in one batch", async () => {
    const [orgs, runners] = await Promise.all([read("org.list", {}), read("runner.list", {})]);
    expect([orgs, runners]).toEqual([{ op: "org.list" }, { op: "runner.list" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("batch");
  });

  it("sends a form's idempotency key, and reports a held call as pending", async () => {
    await op("device.update", { name: "M5" }, { idempotencyKey: "desktop:k1" });
    expect(seen[0]?.body).toMatchObject({ op: "device.update", idempotencyKey: "desktop:k1" });
    held = true;
    await expect(op("device.update", { name: "M5" })).rejects.toMatchObject({
      code: "pending",
    });
  });

  it("adding a phone asks for Touch ID once and sends the proof with the call", async () => {
    const offer = await decide("mobile.pairOffer", {}, { idempotencyKey: "desktop:pair-1" });
    expect(offer).toEqual(OFFER);
    expect(prompts).toEqual([`n0nce\nmobile.pairOffer\n${await inputDigest({})}\n${SUMMARY}`]);
    expect(seen.map((s) => s.body.op)).toEqual(["presence.challenge", "mobile.pairOffer"]);
    expect(seen[1]?.body).toMatchObject({
      input: {},
      presence: { challengeId: "prc_1", nonce: "n0nce", signature: "c2ln" },
    });
    expect(String(seen[1]?.body.idempotencyKey)).toMatch(/^desktop:/);
  });

  it("turning a device's approvals on goes through Touch ID, with its input", async () => {
    await decide("device.update", { deviceId: "dev_m5", decides: true });
    expect(prompts).toHaveLength(1);
    expect(seen.map((s) => s.body.op)).toEqual(["presence.challenge", "device.update"]);
    expect(seen[1]?.body.input).toEqual({ deviceId: "dev_m5", decides: true });
  });

  it("a cancelled Touch ID calls nothing", async () => {
    touchId = "cancel";
    await expect(decide("mobile.pairOffer", {})).rejects.toMatchObject({ code: "cancelled" });
    expect(seen.map((s) => s.body.op)).toEqual(["presence.challenge"]);
  });

  it("never sends an operation that needs a proof without one", async () => {
    // The view's op() refuses one, and so does the main process's call.
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: forcing it past op()'s types.
      op("mobile.pairOffer" as any, {} as any),
    ).rejects.toBeInstanceOf(OpError);
    const handlers = operationHandlers({
      door: () => new Door("https://engine.example", () => "sfd_t", fakeFetch),
      signer: () => null,
      signedOut: () => {},
    });
    expect(await handlers.call({ op: "mobile.pairOffer", input: {} })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    // decide runs only the operations that take a proof.
    expect(await handlers.decide({ op: "runner.list", input: {} })).toMatchObject({
      ok: false,
    });
    expect(seen).toHaveLength(0);
    await expect(decide("mobile.pairOffer", {})).resolves.toBeDefined();
    expect(prompts).toHaveLength(1);
  });

  it("keeps update_required as its own code, so the view can say to update (ADR 0393)", async () => {
    const tooOld = async () =>
      new Response(JSON.stringify({ code: "update_required", error: "update the app" }), {
        status: 426,
      });
    const handlers = operationHandlers({
      door: () => new Door("https://engine.example", () => "sfd_t", tooOld),
      signer: () => null,
      signedOut: () => {},
    });
    expect(await handlers.call({ op: "org.list", input: {} })).toEqual({
      ok: false,
      code: "update_required",
      error: "update the app",
    });
  });
});
