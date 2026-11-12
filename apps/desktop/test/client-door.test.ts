// The screens' operations end to end against a fake client door (spec 40 M3): the view's `read`,
// `op` and `decide` (src/mainview/lib/op.ts) through the main process's handlers
// (src/bun/operations.ts) and the door client (src/bun/door.ts). Touch ID can't run in a test, so
// the device key is a signer that counts its prompts: approving a merge signs exactly once.
import { beforeEach, describe, expect, it } from "vitest";
import { inputDigest } from "../src/bun/digest.ts";
import { Door, type Fetch } from "../src/bun/door.ts";
import { operationHandlers } from "../src/bun/operations.ts";
import { run } from "../src/mainview/lib/decisions.tsx";
import { connect, decide, OpError, op, read } from "../src/mainview/lib/op.ts";

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

let seen: Seen[];
let prompts: string[];
let touchId: "approve" | "cancel";
let held: boolean;

const SUMMARY = 'Merge #7 "Fix the inbox count" into main';

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
  if (body.op === "review.merge" || body.op === "review.sendBack") {
    if (!body.presence) return reply({ error: "browser only", code: "forbidden" }, 403);
    return reply({ result: { alreadyDecided: false, incidentId: null } });
  }
  return reply({ result: { workItemId: "wi_1" } });
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
    const [inbox, item] = await Promise.all([
      read("inbox.list", {}),
      read("workItem.get", { workItemId: "wi_1" }),
    ]);
    expect([inbox, item]).toEqual([{ op: "inbox.list" }, { op: "workItem.get" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("batch");
  });

  it("sends a form's idempotency key, and reports a held call as pending", async () => {
    await op("workItem.cancel", { workItemId: "wi_1" }, { idempotencyKey: "desktop:k1" });
    expect(seen[0]?.body).toMatchObject({ op: "workItem.cancel", idempotencyKey: "desktop:k1" });
    held = true;
    await expect(op("workItem.cancel", { workItemId: "wi_1" })).rejects.toMatchObject({
      code: "pending",
    });
  });

  it("approving a merge asks for Touch ID once and sends the proof with the call", async () => {
    expect(await run({ kind: "review.merge", workItemId: "wi_1", openedFullDiff: true })).toBe(
      "Merging",
    );
    const input = { workItemId: "wi_1", openedFullDiff: true };
    expect(prompts).toEqual([`n0nce\nreview.merge\n${await inputDigest(input)}\n${SUMMARY}`]);
    expect(seen.map((s) => s.body.op)).toEqual(["presence.challenge", "review.merge"]);
    expect(seen[1]?.body).toMatchObject({
      input,
      presence: { challengeId: "prc_1", nonce: "n0nce", signature: "c2ln" },
    });
    expect(String(seen[1]?.body.idempotencyKey)).toMatch(/^desktop:/);
  });

  it("send back goes through Touch ID too, with its note", async () => {
    await run({
      kind: "review.sendBack",
      workItemId: "wi_1",
      note: "Tests fail",
      openedFullDiff: false,
    });
    expect(prompts).toHaveLength(1);
    expect(seen.map((s) => s.body.op)).toEqual(["presence.challenge", "review.sendBack"]);
    expect(seen[1]?.body.input).toEqual({
      workItemId: "wi_1",
      note: "Tests fail",
      openedFullDiff: false,
    });
  });

  it("a cancelled Touch ID decides nothing", async () => {
    touchId = "cancel";
    await expect(
      run({ kind: "review.merge", workItemId: "wi_1", openedFullDiff: true }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(seen.map((s) => s.body.op)).toEqual(["presence.challenge"]);
  });

  it("never sends a gate decision without a proof", async () => {
    // The view's op() refuses one, and so does the main process's call.
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: forcing a decision past op()'s types.
      op("review.merge" as any, { workItemId: "wi_1", openedFullDiff: true } as any),
    ).rejects.toBeInstanceOf(OpError);
    const handlers = operationHandlers({
      door: () => new Door("https://engine.example", () => "sfd_t", fakeFetch),
      signer: () => null,
      signedOut: () => {},
    });
    expect(
      await handlers.call({ op: "spec.approve", input: { workItemId: "wi_1" } }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    // decide runs only gate decisions.
    expect(await handlers.decide({ op: "workItem.cancel", input: {} })).toMatchObject({
      ok: false,
    });
    expect(seen).toHaveLength(0);
    await expect(decide("spec.approve", { workItemId: "wi_1" })).resolves.toBeDefined();
    expect(prompts).toHaveLength(1);
  });
});
