// The desktop app's side of the client door (ADR 0391, spec 40 M1) end to end through sf-engine's
// /client/v1: the PKCE sign-in, desktop tokens on the `desktop` surface, presence proofs that let a
// device make exactly one call, and what stays browser-only whatever the proof.
import { env } from "cloudflare:workers";
import { canonicalJson, inputDigest, presenceMessage, rawSignature } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { pruneChannelStore } from "../src/channel.ts";
import { DESKTOP_PROTOCOL_LATEST } from "../src/cli.ts";
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
    expect((await callOp(token, "org.list", {})).status).toBe(200);
    expect((await callOp(token, "github.connectStart", { orgId: w.orgId })).status).toBe(200);
    const audited = await first<{ origin: string }>(
      "SELECT origin FROM core_audit WHERE operation = 'github.connectStart' AND org_id = ? ORDER BY rowid DESC LIMIT 1",
      w.orgId,
    );
    expect(JSON.parse(String(audited?.origin))).toMatchObject({ surface: "desktop", deviceId });
    // /cli/v1 is the same door.
    expect((await post("call", { op: "org.list", input: {} }, token, "/cli/v1")).status).toBe(200);
    // batch runs reads only, the new core's included.
    const batch = await json<{ results: { ok: boolean; code?: string }[] }>(
      await post(
        "batch",
        {
          calls: [
            { op: "org.list", input: {} },
            { op: "flow.project.list", input: { orgId: w.orgId } },
            { op: "github.connectStart", input: { orgId: w.orgId } },
            { op: "flow.agent.create", input: { orgId: w.orgId, name: "x", instructions: "x" } },
          ],
        },
        token,
      ),
    );
    expect(batch.results.map((r) => r.ok)).toEqual([true, true, false, false]);
    expect(batch.results[2]?.code).toBe("forbidden");
  });

  it("refuses a browser-only call without a proof, and lets exactly one proven call past (criteria 3, 4)", async () => {
    const w = await world();
    const { token, device, deviceId } = await signIn(w);
    const op = "mobile.pairOffer";
    const input = {};

    const bare = await callOp(token, op, input);
    expect(bare.status).toBe(403);
    expect(await json(bare)).toMatchObject({ code: "forbidden", details: { browserOnly: true } });

    const proof = await prove(token, device, op, input);
    // The prompt says what it is for, from the engine's own words.
    expect(proof.summary).toBe("Add a phone to your account");
    const proven = await callOp(token, op, input, proof);
    expect(proven.status).toBe(200);
    const audit = await first<{ origin: string }>(
      "SELECT origin FROM core_audit WHERE operation = 'presence.redeem' ORDER BY at DESC LIMIT 1",
    );
    expect(JSON.parse(String(audit?.origin)).surface).toBe("desktop");

    // Replayed.
    expect((await callOp(token, op, input, proof)).status).toBe(403);
    // For another op.
    const forUpdate = await prove(token, device, "device.update", { deviceId, name: "Mac" });
    expect((await callOp(token, op, input, forUpdate)).status).toBe(403);
    // For another input.
    const forOther = await prove(token, device, "device.update", { deviceId, name: "Other" });
    expect((await callOp(token, "device.update", { deviceId, name: "Mac" }, forOther)).status).toBe(
      403,
    );
    // Signed by another device.
    const stranger = await newDevice();
    const forged = await prove(token, stranger, op, input);
    expect((await callOp(token, op, input, forged)).status).toBe(403);
    // Expired: age the challenge past its minute.
    const late = await prove(token, device, op, input);
    await env.DB.prepare("UPDATE core_presence_challenges SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), late.challengeId)
      .run();
    expect((await callOp(token, op, input, late)).status).toBe(403);
  });

  it("a Secure Enclave key approved for a Mac revokes its software-key device (spec 40 M4b migration)", async () => {
    const w = await world();
    const soft = await signIn(w, undefined, "software");
    const me = async (token: string) => (await callOp(token, "desktopDevice.list", {})).status;
    expect(await me(soft.token)).toBe(200);
    // The website's approval page says which software-key Mac a Secure Enclave sign-in replaces.
    const lookupFor = async (keyStorage: string) => {
      const d = await newDevice();
      const { challenge } = await pkce();
      const started = await json<{ requestId: string }>(
        await post("desktop/start", {
          deviceName: "Tim's MacBook Pro",
          publicKey: d.publicKey,
          keyStorage,
          codeChallenge: challenge,
          state: b64url(crypto.getRandomValues(new Uint8Array(16))),
        }),
      );
      return ok<{ replacesSoftwareMac: string | null }>(
        "desktop.authLookup",
        { requestId: started.requestId },
        w.human,
      );
    };
    expect((await lookupFor("secure-enclave")).replacesSoftwareMac).toBe("Tim's MacBook Pro");
    expect((await lookupFor("software")).replacesSoftwareMac).toBeNull();
    // The Mac signs in again with its new Secure Enclave key (its revoke may have failed offline).
    const enclave = await signIn(w);
    expect((await lookupFor("secure-enclave")).replacesSoftwareMac).toBeNull();
    expect(await me(soft.token)).toBe(401);
    const old = await first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM core_desktop_devices WHERE id = ?",
      soft.deviceId,
    );
    expect(old?.revoked_at).not.toBeNull();
    // Only software-key Macs are replaced: another Secure Enclave device leaves this one signed in.
    const otherSe = await signIn(w);
    expect(await me(otherSe.token)).toBe(200);
    expect(await me(enclave.token)).toBe(200);
  });

  it("keeps authority-granting operations browser-only even with a proof (criterion 5)", async () => {
    const w = await world();
    const { token } = await signIn(w);
    for (const op of [
      "cli.approveDevice",
      "desktop.approveDevice",
      "mobile.approveDevice",
      "runner.approveDevice",
      "runner.register",
      "runner.rotateKey",
    ]) {
      const res = await callOp(token, "presence.challenge", { op, input: {} });
      expect([op, res.status]).toEqual([op, 403]);
    }
  });

  it("refuses proofs from a software key: an unsigned build can't give one (criterion 6)", async () => {
    const w = await world();
    const { token, device } = await signIn(w, undefined, "software");
    const input = {};
    const proof = await prove(token, device, "mobile.pairOffer", input);
    const res = await callOp(token, "mobile.pairOffer", input, proof);
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
    const res = await callOp(token, "presence.challenge", { op: "mobile.pairOffer", input: {} });
    expect(res.status).toBe(403);
  });

  it("revoking a device ends its token (criterion 8)", async () => {
    const w = await world();
    const { token, deviceId } = await signIn(w);
    const listed = await ok<{ devices: { id: string }[] }>("desktopDevice.list", {}, w.human);
    expect(listed.devices.map((d) => d.id)).toContain(deviceId);
    await ok("desktopDevice.revoke", { deviceId }, w.human);
    expect((await callOp(token, "org.list", {})).status).toBe(401);
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

    ws.close();
  });

  it("answers update_required to a desktop build below DESKTOP_MIN_PROTOCOL (spec 40 M4, ADR 0393)", async () => {
    const w = await world();
    const { token } = await signIn(w);
    const at = (
      min: string,
      protocol?: string,
      path = "call",
      auth: string | null = token,
      method = "POST",
    ) =>
      worker.fetch(
        new Request(`https://sf-engine.example/client/v1/${path}`, {
          method,
          ...(method === "POST" ? { body: JSON.stringify({ op: "org.list", input: {} }) } : {}),
          headers: {
            "content-type": "application/json",
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
            ...(protocol ? { "x-sf-client-protocol": protocol } : {}),
          },
        }),
        { ...env, DESKTOP_MIN_PROTOCOL: min },
      );
    // No floor (the default): every build is served, with or without the header.
    expect((await at("")).status).toBe(200);
    expect((await at("", "1")).status).toBe(200);
    // A floor of 1: no header (a build before the handshake) and junk are too old.
    for (const p of [undefined, "0", "two"]) {
      const res = await at("1", p);
      expect(res.status).toBe(426);
      expect(await json(res)).toMatchObject({ code: "update_required", minProtocol: 1 });
    }
    expect((await at("1", "1")).status).toBe(200);
    expect((await at("1", "2")).status).toBe(200);
    // One gate for every route: batch, ops, the live socket (refused before any upgrade), and a
    // path no route knows yet still answers update_required, not 404, to an old desktop token.
    expect((await at("1", undefined, "batch")).status).toBe(426);
    expect((await at("1", undefined, "ops", token, "GET")).status).toBe(426);
    expect((await at("1", undefined, "live", token, "GET")).status).toBe(426);
    // Sign-in is refused too, before it mints anything.
    expect((await at("1", undefined, "desktop/start", null)).status).toBe(426);
    // No token is no desktop: the route answers 401 as before.
    expect((await at("1", undefined, "call", null)).status).toBe(401);
    // A floor above the newest protocol this engine knows would lock every build out, sign-in
    // included: it is ignored, not enforced.
    expect(DESKTOP_PROTOCOL_LATEST).toBe(2);
    expect((await at("3", "2")).status).toBe(200);
    expect((await at("99", undefined, "desktop/start", null)).status).not.toBe(426);
  });

  it("caps waiting sign-ins and prunes old requests and challenges", async () => {
    const w = await world();
    const { token, device } = await signIn(w);
    await prove(token, device, "mobile.pairOffer", {});
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
