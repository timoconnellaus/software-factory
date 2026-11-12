// The desktop app's side of the client door (ADR 0381, spec 40 M1) end to end through sf-engine's
// /client/v1: the PKCE sign-in, desktop tokens on the `desktop` surface, presence proofs that let a
// device decide exactly one gate, and what stays browser-only whatever the proof.
import { env } from "cloudflare:workers";
import { canonicalJson, inputDigest, presenceMessage, rawSignature } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { pruneChannelStore } from "../src/channel.ts";
import worker from "../src/index.ts";
import { notifyClients } from "../src/outbox.ts";
import { first, ok, type World, world } from "./helpers.ts";

const post = (path: string, body: unknown, token?: string, prefix = "/client/v1") =>
  worker.fetch(
    new Request(`https://sf-engine.example${prefix}/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
    env,
  );
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A device: a P-256 key pair standing in for the Secure Enclave key. */
async function newDevice() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const sign = async (message: string) =>
    b64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          new TextEncoder().encode(message),
        ),
      ),
    );
  return { publicKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, sign };
}
type Device = Awaited<ReturnType<typeof newDevice>>;

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  return { verifier, challenge };
}

/** The whole sign-in: the app starts, the person approves on the website, the app exchanges. */
async function signIn(w: World, device?: Device, keyStorage = "secure-enclave") {
  const d = device ?? (await newDevice());
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const started = await json<{ requestId: string; approveUrl: string }>(
    await post("desktop/start", {
      deviceName: "Tim's MacBook Pro",
      publicKey: d.publicKey,
      keyStorage,
      codeChallenge: challenge,
      state,
    }),
  );
  expect(started.approveUrl).toContain(`/desktop/connect?request=${started.requestId}`);
  const looked = await ok<{ deviceName: string; keyStorage: string; status: string }>(
    "desktop.authLookup",
    { requestId: started.requestId },
    w.human,
  );
  expect(looked).toMatchObject({
    deviceName: "Tim's MacBook Pro",
    keyStorage,
    status: "pending",
  });
  const approved = await ok<{ redirectUrl: string }>(
    "desktop.approveDevice",
    { requestId: started.requestId },
    w.human,
  );
  const callback = new URL(approved.redirectUrl);
  expect(`${callback.protocol}//${callback.host}${callback.pathname}`).toBe("sf://auth/callback");
  expect(callback.searchParams.get("state")).toBe(state);
  const code = callback.searchParams.get("code") ?? "";
  const res = await post("desktop/exchange", { code, codeVerifier: verifier });
  expect(res.status).toBe(200);
  const got = await json<{ token: string; deviceId: string; tokenId: string }>(res);
  expect(got.token).toMatch(/^sfd_/);
  return { ...got, device: d, code, verifier };
}

const callOp = (token: string, op: string, input: unknown, presence?: unknown) =>
  post("call", { op, input, ...(presence ? { presence } : {}) }, token);

/** Ask for a challenge for this op and input, and sign it with the device key. */
async function prove(token: string, device: Device, op: string, input: unknown) {
  const res = await callOp(token, "presence.challenge", { op, input });
  expect(res.status).toBe(200);
  const { result } = await json<{
    result: { challengeId: string; nonce: string; inputDigest: string; summary: string };
  }>(res);
  expect(result.inputDigest).toBe(await inputDigest(input));
  return {
    challengeId: result.challengeId,
    nonce: result.nonce,
    summary: result.summary,
    signature: await device.sign(
      presenceMessage(result.nonce, op, result.inputDigest, result.summary),
    ),
  };
}

async function newItem(w: World, token: string) {
  const created = await callOp(token, "workItem.create", {
    projectId: w.projectId,
    title: "From the desktop",
    source: "app",
    eventId: crypto.randomUUID(),
  });
  expect(created.status).toBe(200);
  return (await json<{ result: { workItemId: string } }>(created)).result.workItemId;
}

describe("the desktop app's client door (/client/v1)", () => {
  it("signs in once with PKCE; a wrong verifier or a reused code mints nothing (criterion 1)", async () => {
    const w = await world();
    const got = await signIn(w);
    const reused = await post("desktop/exchange", { code: got.code, codeVerifier: got.verifier });
    expect(reused.status).toBe(403);

    // A wrong verifier.
    const d = await newDevice();
    const { challenge } = await pkce();
    const started = await json<{ requestId: string }>(
      await post("desktop/start", {
        deviceName: "Other Mac",
        publicKey: d.publicKey,
        codeChallenge: challenge,
        state: "s".repeat(16),
      }),
    );
    const approved = await ok<{ redirectUrl: string }>(
      "desktop.approveDevice",
      { requestId: started.requestId },
      w.human,
    );
    const code = new URL(approved.redirectUrl).searchParams.get("code") ?? "";
    const wrong = await post("desktop/exchange", { code, codeVerifier: (await pkce()).verifier });
    expect(wrong.status).toBe(403);
    const tokens = await first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM core_cli_tokens WHERE kind = 'desktop' AND user_id = ?",
      w.userId,
    );
    expect(tokens?.n).toBe(1);
    // Not a P-256 point.
    const bad = await post("desktop/start", {
      deviceName: "Bad",
      publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) },
      codeChallenge: challenge,
      state: "s".repeat(16),
    });
    expect(bad.status).toBe(400);
  });

  it("a desktop token acts on the desktop surface and the audit names the device (criterion 2)", async () => {
    const w = await world();
    const { token, deviceId } = await signIn(w);
    expect((await callOp(token, "inbox.list", {})).status).toBe(200);
    const workItemId = await newItem(w, token);
    const audited = await first<{ origin: string }>(
      "SELECT origin FROM core_audit WHERE operation = 'workItem.create' AND work_item_id = ?",
      workItemId,
    );
    expect(JSON.parse(String(audited?.origin))).toMatchObject({ surface: "desktop", deviceId });
    // /cli/v1 is the same door.
    expect((await post("call", { op: "inbox.list", input: {} }, token, "/cli/v1")).status).toBe(
      200,
    );
    // batch runs reads only.
    const batch = await json<{ results: { ok: boolean; code?: string }[] }>(
      await post(
        "batch",
        {
          calls: [
            { op: "inbox.list", input: {} },
            { op: "workItem.get", input: { workItemId } },
            { op: "workItem.cancel", input: { workItemId, reason: "x" } },
          ],
        },
        token,
      ),
    );
    expect(batch.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(batch.results[2]?.code).toBe("forbidden");
  });

  it("refuses a gate decision without a proof, and lets exactly one proven call past (criteria 3, 4)", async () => {
    const w = await world();
    const { token, device } = await signIn(w);
    const workItemId = await newItem(w, token);
    const input = { workItemId };

    const bare = await callOp(token, "spec.approve", input);
    expect(bare.status).toBe(403);
    expect(await json(bare)).toMatchObject({ code: "forbidden", details: { browserOnly: true } });

    // With a proof the call gets past the browser-only check: the item isn't at a spec gate, so the
    // handler itself answers (conflict), not the gate (forbidden).
    const proof = await prove(token, device, "spec.approve", input);
    // The prompt names the decision, from the engine's records.
    expect(proof.summary).toMatch(/^Approve the spec for #\d+ "From the desktop"$/);
    const proven = await callOp(token, "spec.approve", input, proof);
    expect(proven.status).not.toBe(403);
    const audit = await first<{ origin: string }>(
      "SELECT origin FROM core_audit WHERE operation = 'presence.redeem' ORDER BY at DESC LIMIT 1",
    );
    expect(JSON.parse(String(audit?.origin)).surface).toBe("desktop");

    // Replayed.
    expect((await callOp(token, "spec.approve", input, proof)).status).toBe(403);
    // For another op.
    const forMerge = await prove(token, device, "review.merge", {
      workItemId,
      openedFullDiff: true,
    });
    expect((await callOp(token, "spec.approve", input, forMerge)).status).toBe(403);
    // For another input.
    const otherItem = await newItem(w, token);
    const forOther = await prove(token, device, "spec.approve", { workItemId: otherItem });
    expect((await callOp(token, "spec.approve", input, forOther)).status).toBe(403);
    // Signed by another device.
    const stranger = await newDevice();
    const forged = await prove(token, stranger, "spec.approve", input);
    expect((await callOp(token, "spec.approve", input, forged)).status).toBe(403);
    // Expired: age the challenge past its minute.
    const late = await prove(token, device, "spec.approve", input);
    await env.DB.prepare("UPDATE core_presence_challenges SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), late.challengeId)
      .run();
    expect((await callOp(token, "spec.approve", input, late)).status).toBe(403);
  });

  it("keeps authority-granting operations browser-only even with a proof (criterion 5)", async () => {
    const w = await world();
    const { token } = await signIn(w);
    for (const op of [
      "cli.approveDevice",
      "desktop.approveDevice",
      "runner.register",
      "killSwitch.set",
    ]) {
      const res = await callOp(token, "presence.challenge", { op, input: {} });
      expect([op, res.status]).toEqual([op, 403]);
    }
    const off = await callOp(token, "killSwitch.set", {
      scope: "project",
      id: w.projectId,
      on: false,
    });
    expect(off.status).toBe(403);
  });

  it("refuses proofs from a software key: an unsigned build can't decide (criterion 6)", async () => {
    const w = await world();
    const { token, device } = await signIn(w, undefined, "software");
    const workItemId = await newItem(w, token);
    const input = { workItemId };
    const proof = await prove(token, device, "spec.approve", input);
    const res = await callOp(token, "spec.approve", input, proof);
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toMatch(/Secure Enclave/);
  });

  it("a CLI token can't ask for a challenge (criterion 7)", async () => {
    const w = await world();
    const started = await json<{ deviceCode: string; userCode: string }>(
      await post("device/start", { name: "tim@m5", scope: "write" }, undefined, "/cli/v1"),
    );
    await ok("cli.approveDevice", { userCode: started.userCode, scope: "write" }, w.human);
    const { token } = await json<{ token: string }>(
      await post("device/poll", { deviceCode: started.deviceCode }, undefined, "/cli/v1"),
    );
    const res = await callOp(token, "presence.challenge", { op: "spec.approve", input: {} });
    expect(res.status).toBe(403);
  });

  it("revoking a device ends its token (criterion 8)", async () => {
    const w = await world();
    const { token, deviceId } = await signIn(w);
    const listed = await ok<{ devices: { id: string }[] }>("desktopDevice.list", {}, w.human);
    expect(listed.devices.map((d) => d.id)).toContain(deviceId);
    await ok("desktopDevice.revoke", { deviceId }, w.human);
    expect((await callOp(token, "inbox.list", {})).status).toBe(401);
  });

  it("canonical digests ignore key order; DER signatures convert to raw", async () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(await inputDigest({ a: 1, b: 2 })).toBe(await inputDigest({ b: 2, a: 1 }));
    // The vector the desktop app's own digest is pinned to too (apps/desktop/test/door.test.ts).
    expect(await inputDigest({ b: [1, { d: undefined, c: "x" }], a: null })).toBe(
      "48aa8d7ca4745dc18af09c1efd1d919435cf93ad6aac93632f0e3cb043fae4f4",
    );
    // DER: SEQUENCE { INTEGER 0x00 ‖ 0x80…, INTEGER 0x01 }
    const r = new Uint8Array(32).fill(0x80);
    const der = new Uint8Array([0x30, 0x26, 0x02, 0x21, 0x00, ...r, 0x02, 0x01, 0x01]);
    const raw = rawSignature(der);
    expect(raw.length).toBe(64);
    expect([...raw.slice(0, 32)]).toEqual([...r]);
    expect(raw[63]).toBe(1);
  });

  it("pushes notifications to the person's open apps over the live socket (M2b)", async () => {
    const w = await world();
    const { token } = await signIn(w);
    const refused = await worker.fetch(
      new Request("https://sf-engine.example/client/v1/live", {
        headers: { upgrade: "websocket" },
      }),
      env,
    );
    expect(refused.status).toBe(401);

    const res = await worker.fetch(
      new Request("https://sf-engine.example/client/v1/live", {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    const got: unknown[] = [];
    ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
    ws.accept();
    const until = async (n: number) => {
      for (let i = 0; i < 50 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    };
    await until(1);
    expect(got[0]).toEqual({ type: "hello" });

    // Assigned to this person.
    await notifyClients(env, {
      event: "gate.opened",
      userId: w.userId,
      title: "Ready to merge: x",
    });
    await until(2);
    expect(got[1]).toMatchObject({
      type: "notify",
      event: "gate.opened",
      title: "Ready to merge: x",
    });

    // Assigned to nobody: the org's owners and admins hear it.
    const workItemId = await newItem(w, token);
    const heard = await notifyClients(env, {
      event: "gate.opened",
      userId: null,
      workItemId,
      title: "Spec waiting: From the desktop",
    });
    expect(heard).toContain(w.userId);
    await until(3);
    expect(got[2]).toMatchObject({ type: "notify", workItemId });
    ws.close();
  });

  it("carries attachment bytes as { $bytes } both ways (spec 40 M3)", async () => {
    const w = await world();
    const { token } = await signIn(w);
    const workItemId = await newItem(w, token);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const b64 = btoa(String.fromCharCode(...png));
    const added = await callOp(token, "workItem.attachment.add", {
      workItemId,
      filename: "shot.png",
      contentType: "image/png",
      bytes: { $bytes: b64 },
    });
    expect(added.status).toBe(200);
    const { result } = await json<{ result: { attachment: { id: string; sizeBytes: number } } }>(
      added,
    );
    expect(result.attachment.sizeBytes).toBe(png.length);
    const got = await json<{ result: { bytes: { $bytes: string } } }>(
      await callOp(token, "workItem.attachment.get", { attachmentId: result.attachment.id }),
    );
    expect(got.result.bytes).toEqual({ $bytes: b64 });
    // In a batch too, and bytes that aren't base64 are refused.
    const batch = await json<{ results: { ok: boolean; result?: { bytes: unknown } }[] }>(
      await post(
        "batch",
        {
          calls: [{ op: "workItem.attachment.get", input: { attachmentId: result.attachment.id } }],
        },
        token,
      ),
    );
    expect(batch.results[0]?.result?.bytes).toEqual({ $bytes: b64 });
    const bad = await callOp(token, "workItem.attachment.add", {
      workItemId,
      filename: "x.png",
      contentType: "image/png",
      bytes: { $bytes: "not base64!" },
    });
    expect(bad.status).toBe(400);
  });

  it("caps waiting sign-ins and prunes old requests and challenges", async () => {
    const w = await world();
    const { token, device } = await signIn(w);
    const workItemId = await newItem(w, token);
    await prove(token, device, "spec.approve", { workItemId });
    // Age everything past a day after expiry: the cron's prune removes it.
    const old = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    await env.DB.prepare("UPDATE core_desktop_auth_requests SET expires_at = ?").bind(old).run();
    await env.DB.prepare("UPDATE core_presence_challenges SET expires_at = ?").bind(old).run();
    await pruneChannelStore(env.DB);
    const left = await first<{ a: number; c: number }>(
      "SELECT (SELECT COUNT(*) FROM core_desktop_auth_requests) AS a, (SELECT COUNT(*) FROM core_presence_challenges) AS c",
    );
    expect(left).toEqual({ a: 0, c: 0 });

    // Fill the pending limit, then the next start is refused.
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    const rows = Array.from({ length: 50 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO core_desktop_auth_requests (id, code_challenge, device_name, public_key, state, created_at, expires_at)
         VALUES (?, 'c', 'x', '{}', 's', ?, ?)`,
      ).bind(`dar_${i.toString(16).padStart(32, "0")}`, now, later),
    );
    await env.DB.batch(rows);
    const d = await newDevice();
    const refused = await post("desktop/start", {
      deviceName: "One too many",
      publicKey: d.publicKey,
      codeChallenge: "A".repeat(43),
      state: "s".repeat(16),
    });
    expect(refused.status).toBe(503);
  });
});
