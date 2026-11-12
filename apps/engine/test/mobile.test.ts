// The phone app's side of the client door (spec 60 PR 1a, ADR 0541) end to end through sf-engine's
// /client/v1: key attestation at sign-in, the browser and pair-offer sign-ins, `mobile` tokens on
// the `mobile` surface, fingerprint proofs bound to exactly what is approved, `review.merge` bound
// to one commit, and revocation.
//
// The full flow uses chains made under a TEST root that only these tests trust (test/attestation.ts,
// `mobileTestSeams.roots`). Two real chains captured from devices (Google's android-key-attestation
// test data, test/fixtures/android-attestation) check the parser and the pinned Google roots.
import { env } from "cloudflare:workers";
import {
  AttestationError,
  DerError,
  GOOGLE_ATTESTATION_ROOTS,
  inputDigest,
  KEY_DESCRIPTION_OID,
  OPERATIONS,
  PAIR_CODE_REFUSED,
  parseCertificate,
  parseKeyDescription,
  presenceMessage,
  readDer,
  verifyAndroidAttestation,
} from "@software-factory/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneChannelStore } from "../src/channel.ts";
import worker from "../src/index.ts";
import {
  clearRevocationCache,
  ipv6Prefix64,
  mobileCaller,
  mobileMac,
  mobileTestSeams,
  revokedSerials,
} from "../src/mobile.ts";
import {
  attestedKey,
  challengeFor,
  type KeyOptions,
  pemToBase64,
  TEST_SIGNING_CERT,
  testRoot,
  thisMonth,
} from "./attestation.ts";
import sbCert0 from "./fixtures/android-attestation/ec-strongbox/cert0.pem?raw";
import sbCert1 from "./fixtures/android-attestation/ec-strongbox/cert1.pem?raw";
import sbCert2 from "./fixtures/android-attestation/ec-strongbox/cert2.pem?raw";
import sbCert3 from "./fixtures/android-attestation/ec-strongbox/cert3.pem?raw";
import teeCert0 from "./fixtures/android-attestation/ec-tee/cert0.pem?raw";
import teeCert1 from "./fixtures/android-attestation/ec-tee/cert1.pem?raw";
import teeCert2 from "./fixtures/android-attestation/ec-tee/cert2.pem?raw";
import teeCert3 from "./fixtures/android-attestation/ec-tee/cert3.pem?raw";
import rkpCert0 from "./fixtures/android-attestation/ec-tee-rkp-2026/cert0.pem?raw";
import rkpCert1 from "./fixtures/android-attestation/ec-tee-rkp-2026/cert1.pem?raw";
import rkpCert2 from "./fixtures/android-attestation/ec-tee-rkp-2026/cert2.pem?raw";
import rkpCert3 from "./fixtures/android-attestation/ec-tee-rkp-2026/cert3.pem?raw";
import rkpCert4 from "./fixtures/android-attestation/ec-tee-rkp-2026/cert4.pem?raw";
import { all, call, first, ok, uid, type World, world } from "./helpers.ts";

const CONFIG_OPS = ["config.save", "config.rollback"];

const PROTOCOL = { "x-sf-client": "mobile", "x-sf-client-protocol": "1" };

/** The address the door sees (`cf-connecting-ip`): a fresh one per test, so limits don't leak. */
let ip = "";
const randomIp = () => `10.${Array.from(crypto.getRandomValues(new Uint8Array(3))).join(".")}`;
/** The engine's env; a test may swap in other vars. */
let engineEnv: Env = env;

const post = (
  path: string,
  body: unknown,
  token?: string,
  headers: Record<string, string> = PROTOCOL,
  from = ip,
) =>
  worker.fetch(
    new Request(`https://sf-engine.example/client/v1/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": from,
        ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
    engineEnv,
  );
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  return { verifier, challenge };
}

let root: Awaited<ReturnType<typeof testRoot>>;
beforeEach(async () => {
  ip = randomIp();
  engineEnv = env;
  root = await testRoot();
  mobileTestSeams.roots = [root.pinned];
  mobileTestSeams.revoked = new Set();
});
afterEach(() => {
  mobileTestSeams.roots = null;
  mobileTestSeams.revoked = null;
  mobileTestSeams.fetch = null;
  mobileTestSeams.beforeCommit = null;
  clearRevocationCache();
});

async function nonce(from = ip) {
  const res = await post("mobile/nonce", {}, undefined, PROTOCOL, from);
  expect(res.status).toBe(200);
  return (await json<{ nonce: string }>(res)).nonce;
}

/** A phone: a nonce, a key attested with its challenge (options override the good defaults). */
async function phone(options: Partial<KeyOptions> = {}, under = root) {
  // Each from its own address: the nonce's courtesy limit isn't what these tests are about, and
  // the typed-code limits key on the address that sends the code.
  const n = await nonce(randomIp());
  const key = await attestedKey(under, { challenge: await challengeFor(n), ...options });
  return { nonce: n, ...key };
}
type Phone = Awaited<ReturnType<typeof phone>>;

async function start(p: Phone, extra: Record<string, unknown> = {}, from = ip) {
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const res = await post(
    "mobile/start",
    {
      nonce: p.nonce,
      attestationChain: p.chain,
      deviceName: "Tim's Pixel 9",
      codeChallenge: challenge,
      state,
      ...extra,
    },
    undefined,
    PROTOCOL,
    from,
  );
  return { res, verifier, state };
}

const tokens = async (userId: string) =>
  (
    await first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM core_cli_tokens WHERE kind = 'mobile' AND user_id = ?",
      userId,
    )
  )?.n ?? 0;

/** The browser sign-in: start, the person approves on the website, the phone exchanges. */
async function browserSignIn(w: World, p?: Phone, decides?: boolean) {
  const ph = p ?? (await phone());
  const { res, verifier, state } = await start(ph);
  expect(res.status).toBe(200);
  const started = await json<{
    status: string;
    requestId: string;
    approveUrl: string;
    keyStorage: string;
  }>(res);
  expect(started.status).toBe("pending");
  expect(started.approveUrl).toContain(`/mobile/connect?request=${started.requestId}`);
  const looked = await ok<{ deviceName: string; keyStorage: string; status: string }>(
    "mobile.authLookup",
    { requestId: started.requestId },
    w.human,
  );
  expect(looked).toMatchObject({ deviceName: "Tim's Pixel 9", status: "pending" });
  const approved = await ok<{ redirectUrl: string }>(
    "mobile.approveDevice",
    { requestId: started.requestId },
    w.human,
  );
  const callback = new URL(approved.redirectUrl);
  expect(callback.pathname).toBe("/mobile/callback");
  expect(callback.searchParams.get("state")).toBe(state);
  const code = callback.searchParams.get("code") ?? "";
  const ex = await post("mobile/exchange", {
    code,
    codeVerifier: verifier,
    ...(decides === undefined ? {} : { decides }),
  });
  expect(ex.status).toBe(200);
  const got = await json<{ token: string; deviceId: string; keyStorage: string }>(ex);
  expect(got.token).toMatch(/^sfm_/);
  return { ...got, phone: ph, code, verifier };
}

const callOp = (token: string, op: string, input: unknown, presence?: unknown) =>
  post("call", { op, input, ...(presence ? { presence } : {}) }, token);

/** A fingerprint proof for this op and input, signed with the phone's attested key. */
async function prove(token: string, p: Pick<Phone, "sign">, op: string, input: unknown) {
  const res = await callOp(token, "presence.challenge", { op, input });
  expect([op, res.status]).toEqual([op, 200]);
  const { result } = await json<{
    result: { challengeId: string; nonce: string; inputDigest: string; summary: string };
  }>(res);
  expect(result.inputDigest).toBe(await inputDigest(input));
  return {
    challengeId: result.challengeId,
    nonce: result.nonce,
    summary: result.summary,
    signature: await p.sign(presenceMessage(result.nonce, op, result.inputDigest, result.summary)),
  };
}

async function newItem(w: World, token: string, title = "From the phone") {
  const created = await callOp(token, "workItem.create", {
    state: "queued",
    projectId: w.projectId,
    title,
    source: "app",
    eventId: crypto.randomUUID(),
  });
  expect(created.status).toBe(200);
  return (await json<{ result: { workItemId: string } }>(created)).result.workItemId;
}

/** A pending gate on a work item, as the Workflow opens one. */
async function gate(
  w: World,
  workItemId: string,
  kind: "spec" | "merge" | "approval",
  input: Record<string, unknown> = {},
  pending: { operation?: string; risk?: string } = {},
) {
  const id = `pa_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, kind, operation, risk, actor_type, actor_id, input, assignee_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'agent', 'foreman', ?, ?, ?)`,
  )
    .bind(
      id,
      w.orgId,
      w.projectId,
      workItemId,
      kind,
      pending.operation ??
        (kind === "merge" ? "pr.merge" : kind === "spec" ? "spec.accept" : "pr.open"),
      pending.risk ?? "merge",
      JSON.stringify(input),
      w.userId,
      new Date().toISOString(),
    )
    .run();
  return id;
}

async function question(w: World, workItemId: string, domain: string, irreversible = false) {
  const id = `q_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    `INSERT INTO core_questions (id, work_item_id, project_id, org_id, domain, prompt, options, default_answer, irreversible, assignee_user_id, planning_round, asked_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'Which?', '["a","b"]', 'a', ?, ?, 1, 'agent', ?)`,
  )
    .bind(
      id,
      workItemId,
      w.projectId,
      w.orgId,
      domain,
      irreversible ? 1 : 0,
      w.userId,
      new Date().toISOString(),
    )
    .run();
  return id;
}

describe("Android key attestation (criterion 1)", () => {
  const tee = [teeCert0, teeCert1, teeCert2, teeCert3].map(pemToBase64);
  const strongbox = [sbCert0, sbCert1, sbCert2, sbCert3].map(pemToBase64);

  it("a captured real chain reaches Google's pinned RSA root, and parses", async () => {
    // The real TEE key from Google's test data: our own expectations taken from its key
    // description, so only the checks that matter to it run. It reaches the pinned root, then is
    // refused because it is a key with no user authentication.
    expect(GOOGLE_ATTESTATION_ROOTS.length).toBe(2);
    const der = Uint8Array.from(atob(tee[0] as string), (c) => c.charCodeAt(0));
    const kd = parseKeyDescription(
      parseCertificate(der).extensions.get(KEY_DESCRIPTION_OID) as Uint8Array,
    );
    expect(kd.attestationSecurityLevel).toBe("tee");
    expect(kd.hardwareEnforced.algorithm).toBe(3);
    expect(kd.hardwareEnforced.ecCurve).toBe(1);
    expect(kd.hardwareEnforced.noAuthRequired).toBe(true);
    expect(kd.hardwareEnforced.rootOfTrust).toEqual({
      deviceLocked: false,
      verifiedBootState: "unverified",
    });
    const app = kd.softwareEnforced.application;
    const refused = await verifyAndroidAttestation(tee, {
      challenge: kd.challenge,
      packageName: app?.packages[0]?.name ?? "",
      signingCerts: app?.signatureDigests ?? [],
      revoked: new Set(),
      now: Date.UTC(2026, 10, 12),
      roots: GOOGLE_ATTESTATION_ROOTS,
    }).catch((e: AttestationError) => e);
    expect(refused).toBeInstanceOf(AttestationError);
    // Every check before the key's authentication passed: the chain, the pinned root, the dates,
    // the extension's place, the challenge and the security level.
    expect((refused as AttestationError).reason).toBe("auth");
    // Revoked by Google, it's refused earlier.
    const revoked = await verifyAndroidAttestation(tee, {
      challenge: kd.challenge,
      packageName: "",
      signingCerts: [],
      revoked: new Set(["388266760658996857d"]),
      now: Date.UTC(2026, 10, 12),
    }).catch((e: AttestationError) => e);
    expect((revoked as AttestationError).reason).toBe("revoked");
  });

  it("a captured real RKP chain reaches Google's pinned ECDSA root (Key Attestation CA1)", async () => {
    // Google's own test data from a Pixel 9a (fixtures/android-attestation/README.md): the real
    // chain behind the 2026 root we pin. Judged inside its RKP certificates' two weeks.
    const rkp = [rkpCert0, rkpCert1, rkpCert2, rkpCert3, rkpCert4].map(pemToBase64);
    const der = Uint8Array.from(atob(rkp[0] as string), (c) => c.charCodeAt(0));
    const kd = parseKeyDescription(
      parseCertificate(der).extensions.get(KEY_DESCRIPTION_OID) as Uint8Array,
    );
    expect(kd.attestationVersion).toBe(400);
    expect(kd.hardwareEnforced.osPatchLevel).toBe(202602);
    const app = kd.softwareEnforced.application;
    const expected = {
      challenge: kd.challenge,
      packageName: app?.packages[0]?.name ?? "",
      signingCerts: app?.signatureDigests ?? [],
      revoked: new Set<string>(),
      now: Date.UTC(2026, 1, 25),
      roots: GOOGLE_ATTESTATION_ROOTS,
    };
    const refused = await verifyAndroidAttestation(rkp, expected).catch((e: AttestationError) => e);
    // The chain, the pinned P-384 root, the CA checks, the dates, the challenge and the security
    // level all pass; the key itself has no user authentication.
    expect((refused as AttestationError).reason).toBe("auth");
    // Under a root list without CA1 it's untrusted.
    const unpinned = await verifyAndroidAttestation(rkp, {
      ...expected,
      roots: GOOGLE_ATTESTATION_ROOTS.filter((r) => !r.name.includes("CA1")),
    }).catch((e: AttestationError) => e);
    expect((unpinned as AttestationError).reason).toBe("untrusted-root");
  });

  it("a captured real chain whose root isn't Google's is refused", async () => {
    const refused = await verifyAndroidAttestation(strongbox, {
      challenge: new Uint8Array(),
      packageName: "",
      signingCerts: [],
      revoked: new Set(),
      now: Date.UTC(2026, 10, 12),
    }).catch((e: AttestationError) => e);
    expect((refused as AttestationError).reason).toBe("untrusted-root");
  });

  it("an attested StrongBox key registers; each failed check is refused and nothing is stored", async () => {
    const w = await world();
    const good = await browserSignIn(
      w,
      await phone({ keyMintSecurityLevel: 2, attestationSecurityLevel: 2 }),
    );
    expect(good.keyStorage).toBe("strongbox");
    const device = await first<{ platform: string; key_storage: string; attestation: string }>(
      "SELECT platform, key_storage, attestation FROM core_desktop_devices WHERE id = ?",
      good.deviceId,
    );
    expect(device).toMatchObject({ platform: "android", key_storage: "strongbox" });
    expect(JSON.parse(String(device?.attestation))).toMatchObject({
      securityLevel: "strongbox",
      verifiedBootState: "verified",
      deviceLocked: true,
      downgraded: null,
    });

    const other = await testRoot();
    const cases: [string, () => Promise<Phone>, string][] = [
      ["a chain that doesn't reach a pinned root", () => phone({}, other), "untrusted-root"],
      ["a wrong challenge", () => phone({ challenge: new Uint8Array(32).fill(1) }), "challenge"],
      ["no biometric auth", () => phone({ userAuthType: null }), "auth"],
      ["noAuthRequired", () => phone({ noAuthRequired: true }), "auth"],
      ["an auth timeout", () => phone({ authTimeout: 300 }), "auth"],
      ["the PIN as a fallback", () => phone({ userAuthType: 3 }), "auth"],
      ["another package", () => phone({ packageName: "com.example.evil" }), "app"],
      ["another signing certificate", () => phone({ signatureDigest: "ab".repeat(32) }), "app"],
      [
        "a software attestation level",
        () => phone({ attestationSecurityLevel: 0 }),
        "security-level",
      ],
      ["a software KeyMint level", () => phone({ keyMintSecurityLevel: 0 }), "security-level"],
      ["an imported key", () => phone({ origin: 2 }), "key"],
      ["a key with no origin", () => phone({ origin: null }), "key"],
      ["an intermediate that isn't a CA", () => phone({ intermediateNotCa: true }), "chain"],
      [
        "a Keymaster attestation (before KeyMint)",
        () => phone({ attestationVersion: 4 }),
        "version",
      ],
      [
        "a security patch older than 18 months",
        () => phone({ osPatchLevel: thisMonth(Date.now() - 19 * 31 * 86_400_000) }),
        "patch",
      ],
      ["a key that can't sign", () => phone({ purpose: [0] }), "key"],
      [
        "a key description beyond the leaf",
        () => phone({ extensionInIntermediate: true }),
        "extension",
      ],
      [
        "an unknown critical extension (name constraints)",
        () => phone({ criticalInLeaf: "2.5.29.30" }),
        "malformed",
      ],
      [
        "an expired intermediate",
        () => phone({ intermediateNotAfter: Date.now() - 1000 }),
        "expired",
      ],
    ];
    const before = await all(
      "SELECT id FROM core_desktop_auth_requests WHERE platform = 'android'",
    );
    for (const [what, make, reason] of cases) {
      const { res } = await start(await make());
      const body = await json<{ code: string; details?: { attestation?: string } }>(res);
      expect([what, res.status, body.details?.attestation]).toEqual([what, 403, reason]);
    }
    // A revoked certificate.
    const revokedPhone = await phone();
    mobileTestSeams.revoked = new Set([revokedPhone.serials.intermediate]);
    const revoked = await start(revokedPhone);
    expect(revoked.res.status).toBe(403);
    expect(
      (await json<{ details: { attestation: string } }>(revoked.res)).details.attestation,
    ).toBe("revoked");
    mobileTestSeams.revoked = new Set();
    // Nothing was stored for any of them, and only the good phone has a token.
    const after = await all("SELECT id FROM core_desktop_auth_requests WHERE platform = 'android'");
    expect(after.length).toBe(before.length);
    expect(await tokens(w.userId)).toBe(1);
  });

  it("DER only: a length or tag number not in its shortest form is refused", () => {
    const ok = new Uint8Array([0x04, 0x02, 0xaa, 0xbb]);
    expect(readDer(ok).end).toBe(4);
    const long = new Uint8Array([0x04, 0x81, 0x80, ...new Uint8Array(0x80)]);
    expect(readDer(long).end).toBe(long.length);
    for (const bytes of [
      [0x04, 0x81, 0x02, 0xaa, 0xbb], // long form for a length under 128
      [0x04, 0x82, 0x00, 0x02, 0xaa, 0xbb], // a leading zero byte
      [0x04, 0x82, 0x00, 0x80, ...new Uint8Array(0x80)],
      [0x9f, 0x05, 0x00], // a high tag number form for tag 5
      [0x9f, 0x80, 0x81, 0x00], // a leading 0x80 in the tag number
    ]) {
      expect(() => readDer(new Uint8Array(bytes))).toThrow(DerError);
    }
  });

  it("a nonce is used once, and a chain can't be replayed with a fresh one", async () => {
    const w = await world();
    const p = await phone();
    await browserSignIn(w, p);
    // The same nonce again.
    expect((await start(p)).res.status).toBe(403);
    // The same chain with a new nonce: its challenge isn't this sign-in's.
    const replay = await start({ ...p, nonce: await nonce() });
    expect(replay.res.status).toBe(403);
    expect((await json<{ details: { attestation: string } }>(replay.res)).details.attestation).toBe(
      "challenge",
    );
  });

  it("an unverified boot or an unlocked bootloader registers as `software`, refused at approval", async () => {
    const w = await world();
    for (const options of [{ verifiedBootState: 2 }, { deviceLocked: false }]) {
      const got = await browserSignIn(w, await phone(options));
      expect(got.keyStorage).toBe("software");
      // One tap still works.
      expect((await callOp(got.token, "inbox.list", {})).status).toBe(200);
      const workItemId = await newItem(w, got.token);
      await gate(w, workItemId, "spec");
      const input = { workItemId };
      const proof = await prove(got.token, got.phone, "spec.approve", input);
      const res = await callOp(got.token, "spec.approve", input, proof);
      expect(res.status).toBe(403);
      expect((await json<{ error: string }>(res)).error).toMatch(/can't approve/);
    }
  });

  it("fails closed when Google's revocation list can't be fetched", async () => {
    mobileTestSeams.revoked = null;
    clearRevocationCache();
    mobileTestSeams.fetch = async () => new Response("down", { status: 503 });
    const { res } = await start(await phone());
    expect(res.status).toBe(503);
    // A good list is parsed and its serials normalised.
    mobileTestSeams.fetch = async () =>
      Response.json({ entries: { "0a1B": { status: "REVOKED" }, ff: { status: "SUSPENDED" } } });
    expect([...(await revokedSerials())]).toEqual(["a1b", "ff"]);
  });
});

describe("pairing: the browser and the pair offer (criteria 2 and 3)", () => {
  it("the browser flow mints exactly one token; a reused code or a wrong verifier mints nothing", async () => {
    const w = await world();
    const got = await browserSignIn(w);
    expect(
      (await post("mobile/exchange", { code: got.code, codeVerifier: got.verifier })).status,
    ).toBe(403);
    // A wrong PKCE verifier.
    const { res } = await start(await phone());
    const { requestId } = await json<{ requestId: string }>(res);
    const approved = await ok<{ redirectUrl: string }>(
      "mobile.approveDevice",
      { requestId },
      w.human,
    );
    const code = new URL(approved.redirectUrl).searchParams.get("code") ?? "";
    expect(
      (await post("mobile/exchange", { code, codeVerifier: (await pkce()).verifier })).status,
    ).toBe(403);
    expect(await tokens(w.userId)).toBe(1);
    // A desktop's lookup doesn't see a phone's request, and the reverse.
    const desktopLookup = await ok("mobile.authLookup", { requestId }, w.human).catch(
      (e: Error) => e,
    );
    expect(desktopLookup).not.toBeInstanceOf(Error);
    await expect(ok("desktop.authLookup", { requestId }, w.human)).rejects.toThrow(
      /no such sign-in/,
    );
  });

  it("the QR flow mints exactly one token; a reused or expired offer is refused", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; pairUrl: string; code: string }>(
      "mobile.pairOffer",
      {},
      w.human,
    );
    const url = new URL(offer.pairUrl);
    expect(url.pathname).toBe("/mobile/pair");
    expect(url.searchParams.get("offer")).toBe(offer.offerId);
    const secret = new URLSearchParams(url.hash.slice(1)).get("secret") ?? "";
    expect(offer.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    // Wrong secret.
    const wrong = await start(await phone(), {
      offer: { offerId: offer.offerId, secret: "x".repeat(43) },
    });
    expect(wrong.res.status).toBe(403);

    const s = await start(await phone(), { offer: { offerId: offer.offerId, secret } });
    expect(s.res.status).toBe(200);
    const started = await json<{ status: string; code: string }>(s.res);
    expect(started.status).toBe("approved");
    const waiting = await ok<{ status: string }>(
      "mobile.pairOfferStatus",
      { offerId: offer.offerId },
      w.human,
    );
    expect(waiting.status).toBe("pairing");
    const ex = await post("mobile/exchange", { code: started.code, codeVerifier: s.verifier });
    expect(ex.status).toBe(200);
    const { deviceId } = await json<{ deviceId: string }>(ex);
    const status = await ok<{
      status: string;
      device: { id: string; name: string; keyStorage: string };
    }>("mobile.pairOfferStatus", { offerId: offer.offerId }, w.human);
    expect(status).toMatchObject({
      status: "paired",
      device: { id: deviceId, name: "Tim's Pixel 9", keyStorage: "tee" },
    });
    expect(await tokens(w.userId)).toBe(1);
    // Reused.
    const again = await start(await phone(), { offer: { offerId: offer.offerId, secret } });
    expect(again.res.status).toBe(403);
    // Not my phone? Remove.
    await ok("device.revoke", { deviceId }, w.human);

    // Expired.
    const late = await ok<{ offerId: string; pairUrl: string }>("mobile.pairOffer", {}, w.human);
    await env.DB.prepare("UPDATE core_pair_offers SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), late.offerId)
      .run();
    const lateSecret = new URLSearchParams(new URL(late.pairUrl).hash.slice(1)).get("secret");
    const expired = await start(await phone(), {
      offer: { offerId: late.offerId, secret: lateSecret },
    });
    expect(expired.res.status).toBe(403);
    expect(await tokens(w.userId)).toBe(1);
  });

  it("a typed code pairs; five wrong ones close the offer", async () => {
    const w = await world();
    await env.DB.prepare("DELETE FROM core_pair_code_tries").run();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    // Typed by hand, in lower case and without the dash.
    const typed = offer.code.replace("-", "").toLowerCase();
    const s = await start(await phone(), { offer: { code: typed } });
    expect(s.res.status).toBe(200);
    const started = await json<{ code: string }>(s.res);
    expect(
      (await post("mobile/exchange", { code: started.code, codeVerifier: s.verifier })).status,
    ).toBe(200);

    const next = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const tag = next.code.slice(0, 2);
    const wrongCode = (i: number) => `${tag}${"ZZZZZZZZ".slice(0, 7)}${i}`;
    for (let i = 0; i < 5; i++) {
      const bad = await start(await phone(), { offer: { code: wrongCode(i) } });
      expect(bad.res.status).toBe(403);
      expect((await json<{ error: string }>(bad.res)).error).toBe(PAIR_CODE_REFUSED);
      // Only the screen showing the code is told how many wrong tries it has had.
      expect(
        await ok<{ wrongTries: number }>(
          "mobile.pairOfferStatus",
          { offerId: next.offerId },
          w.human,
        ),
      ).toMatchObject({ wrongTries: i + 1, maxWrongTries: 5 });
    }
    const closed = await first<{ closed_at: string | null; attempts: number }>(
      "SELECT closed_at, attempts FROM core_pair_offers WHERE id = ?",
      next.offerId,
    );
    expect(closed?.attempts).toBe(5);
    expect(closed?.closed_at).not.toBeNull();
    // Even the right code is refused now, with the answer every refused code gets; the owner's
    // screen says the offer closed.
    const right = await start(await phone(), { offer: { code: next.code } });
    expect(right.res.status).toBe(403);
    expect((await json<{ error: string }>(right.res)).error).toBe(PAIR_CODE_REFUSED);
    expect(await tokens(w.userId)).toBe(1);
  });

  it("Add a phone from the desktop takes Touch ID; device approvals stay refused (criterion 3)", async () => {
    const w = await world();
    // A Mac, signed in the desktop way.
    const mac = await desktopSignIn(w);
    const bare = await post("call", { op: "mobile.pairOffer", input: {} }, mac.token, {});
    expect(bare.status).toBe(403);
    const proof = await prove(mac.token, mac, "mobile.pairOffer", {});
    expect(proof.summary).toBe("Add a phone to your account");
    const proven = await post(
      "call",
      { op: "mobile.pairOffer", input: {}, presence: proof },
      mac.token,
      {},
    );
    expect(proven.status).toBe(200);
    const offer = (await json<{ result: { offerId: string } }>(proven)).result;
    expect(
      await first<{ surface: string }>(
        "SELECT surface FROM core_pair_offers WHERE id = ?",
        offer.offerId,
      ),
    ).toEqual({ surface: "desktop" });
    // Runner, CLI and desktop approvals stay browser-only, proof or not.
    for (const op of [
      "runner.approveDevice",
      "cli.approveDevice",
      "desktop.approveDevice",
      "mobile.approveDevice",
    ]) {
      const res = await post(
        "call",
        { op: "presence.challenge", input: { op, input: {} } },
        mac.token,
        {},
      );
      expect([op, res.status]).toEqual([op, 403]);
    }
    // A phone can't offer a pairing.
    const p = await browserSignIn(w);
    expect((await callOp(p.token, "mobile.pairOffer", {})).status).toBe(403);
    expect(
      (await callOp(p.token, "presence.challenge", { op: "mobile.pairOffer", input: {} })).status,
    ).toBe(403);
  });
});

/** The desktop's sign-in (spec 40), for the Mac side of these tests. */
/** The hash the door keys a caller's limits by, for an address. */
const callerOf = (address: string) =>
  mobileCaller(new Request("https://x", { headers: { "cf-connecting-ip": address } }), env);

/** Typed-code tries already made in the last hour, from a caller. */
async function pastTries(address: string, n: number, ok = 0) {
  const caller = await callerOf(address);
  const at = new Date(Date.now() - 60_000).toISOString();
  await env.DB.batch(
    Array.from({ length: n }, () =>
      env.DB.prepare(
        "INSERT INTO core_pair_code_tries (id, at, ok, caller) VALUES (?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), at, ok, caller),
    ),
  );
}

/** A wrong code that names an offer by its first two characters. */
const wrongFor = (code: string, i: number) => {
  const plain = code.replace("-", "");
  const guess = `${plain.slice(0, 2)}${String(i).padStart(8, "Z")}`.slice(0, 10);
  return guess === plain ? `${plain.slice(0, 2)}ZZZZZZZZ` : guess;
};

describe("the typed code's limits hold under parallel guessing (review of PR 1a)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM core_pair_code_tries").run();
  });

  it("parallel wrong guesses from many phones close the offer at exactly five", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const attackers = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const from = `203.0.113.${i + 1}`;
        return { from, p: await phone() };
      }),
    );
    const results = await Promise.all(
      attackers.map(({ from, p }, i) =>
        start(p, { offer: { code: wrongFor(offer.code, i) } }, from),
      ),
    );
    expect(results.map((r) => r.res.status)).toEqual(results.map(() => 403));
    const row = await first<{ attempts: number; closed_at: string | null }>(
      "SELECT attempts, closed_at FROM core_pair_offers WHERE id = ?",
      offer.offerId,
    );
    expect(row?.attempts).toBe(5);
    expect(row?.closed_at).not.toBeNull();
    // The owner's right code is refused like any other; their screen says the offer closed.
    const owner = await start(await phone(), { offer: { code: offer.code } });
    expect(owner.res.status).toBe(403);
    expect((await json<{ error: string }>(owner.res)).error).toBe(PAIR_CODE_REFUSED);
    expect(
      await ok<{ status: string }>("mobile.pairOfferStatus", { offerId: offer.offerId }, w.human),
    ).toMatchObject({ status: "closed", wrongTries: 5 });
    expect(await tokens(w.userId)).toBe(0);
  });

  it("one nonce carries one guess: parallel codes on it count once", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const p = await phone();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => start(p, { offer: { code: wrongFor(offer.code, i) } })),
    );
    expect(results.filter((r) => r.res.status === 403).length).toBeGreaterThanOrEqual(1);
    const tries = await first<{ n: number }>("SELECT COUNT(*) AS n FROM core_pair_code_tries");
    expect(tries?.n).toBe(1);
    const row = await first<{ attempts: number }>(
      "SELECT attempts FROM core_pair_offers WHERE id = ?",
      offer.offerId,
    );
    expect(row?.attempts).toBe(1);
  });

  it("a bad chain is refused before the code is read, the same for a right and a wrong code, and spends the nonce", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const other = await testRoot();
    const right = await start(await phone({}, other), { offer: { code: offer.code } });
    const wrong = await start(await phone({}, other), { offer: { code: wrongFor(offer.code, 1) } });
    const a = await json(right.res);
    const b = await json(wrong.res);
    expect([right.res.status, wrong.res.status]).toEqual([403, 403]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ details: { attestation: "untrusted-root" } });
    // Nothing was counted, and the offer is untouched.
    expect((await first<{ n: number }>("SELECT COUNT(*) AS n FROM core_pair_code_tries"))?.n).toBe(
      0,
    );
    expect(
      (
        await first<{ attempts: number }>(
          "SELECT attempts FROM core_pair_offers WHERE id = ?",
          offer.offerId,
        )
      )?.attempts,
    ).toBe(0);
    // The refusal spent the nonce: a good key for it is refused as used.
    const junk = await phone({}, other);
    expect((await start(junk, { offer: { code: wrongFor(offer.code, 2) } })).res.status).toBe(403);
    const good = await attestedKey(root, { challenge: await challengeFor(junk.nonce) });
    const again = await start({ ...junk, ...good }, { offer: { code: offer.code } });
    expect(again.res.status).toBe(403);
    expect((await json<{ error: string }>(again.res)).error).toMatch(/nonce is used/);
    // The owner still pairs.
    expect((await start(await phone(), { offer: { code: offer.code } })).res.status).toBe(200);
  });

  it("one caller gets ten codes an hour, counted in SQL; the owner elsewhere still pairs", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const attacker = "198.51.100.66";
    await pastTries(attacker, 6);
    // Ten at once from the caller: only four fit under its ten.
    const phones = await Promise.all(Array.from({ length: 10 }, () => phone()));
    const results = await Promise.all(
      phones.map((p, i) => start(p, { offer: { code: `00ZZZZZZZ${i}` } }, attacker)),
    );
    expect(results.every((r) => r.res.status === 403 || r.res.status === 503)).toBe(true);
    const mine = await first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM core_pair_code_tries WHERE caller = ?",
      await callerOf(attacker),
    );
    expect(mine?.n).toBe(10);
    // The next one is refused before it's counted.
    const held = await start(await phone(), { offer: { code: "00ZZZZZZZZ" } }, attacker);
    expect(held.res.status).toBe(503);
    // None of it touched the owner's offer, and the owner pairs from their own address.
    const owner = await start(await phone(), { offer: { code: offer.code } });
    expect(owner.res.status).toBe(200);
  });

  it("thirty wrong codes an hour hold repeat guessers, never a caller's first code", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    await pastTries("192.0.2.1", 30);
    // A caller who already sent a wrong code this hour is held.
    const repeat = "192.0.2.2";
    await pastTries(repeat, 1);
    const held = await start(await phone(), { offer: { code: "00ZZZZZZZZ" } }, repeat);
    expect(held.res.status).toBe(503);
    // The owner's first code goes through.
    const owner = await start(await phone(), { offer: { code: offer.code } });
    expect(owner.res.status).toBe(200);
  });

  it("nonces are stateless until used: no number of callers blocks anyone else's sign-in", async () => {
    // Twenty /64s asking ten nonces each (the second review's attack) store nothing...
    const before = await first<{ n: number }>("SELECT COUNT(*) AS n FROM core_mobile_nonces");
    const asks = await Promise.all(
      Array.from({ length: 25 }, (_, a) =>
        Promise.all(
          Array.from({ length: 10 }, () =>
            post("mobile/nonce", {}, undefined, PROTOCOL, `2001:db8:${a.toString(16)}:1::9`),
          ),
        ),
      ),
    );
    expect(asks.flat().map((r) => r.status)).toEqual(Array(250).fill(200));
    expect((await first<{ n: number }>("SELECT COUNT(*) AS n FROM core_mobile_nonces"))?.n).toBe(
      before?.n,
    );
    // ...and a fresh address still gets one and signs in.
    const w = await world();
    await browserSignIn(w);
    // The per-caller limit is a courtesy: the eleventh in a minute holds that caller only.
    const held = await post("mobile/nonce", {}, undefined, PROTOCOL, "2001:db8:0:1::77");
    expect(held.status).toBe(503);
    expect((await post("mobile/nonce", {}, undefined, PROTOCOL, "198.51.100.10")).status).toBe(200);
  });

  it("asking for a nonce writes nothing to D1, within the limit or over it", async () => {
    // The courtesy limit is the Workers rate limiting binding (MOBILE_NONCE_LIMIT), checked at the
    // door before the call: no counter rows, and mobile.nonce is a read, so no audit row either.
    const rows = async () =>
      first<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM core_audit WHERE operation = 'mobile.nonce')
              + (SELECT COUNT(*) FROM core_mobile_nonces) AS n`,
      );
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'core_mobile_nonce_asks'",
    ).all();
    expect(tables.results).toEqual([]);
    const before = await rows();
    const from = "203.0.113.200";
    const answers = [];
    for (let i = 0; i < 12; i++) {
      answers.push((await post("mobile/nonce", {}, undefined, PROTOCOL, from)).status);
    }
    expect(answers).toEqual([...Array(10).fill(200), 503, 503]);
    const over = await post("mobile/nonce", {}, undefined, PROTOCOL, from);
    expect(await json(over)).toMatchObject({ code: "unavailable" });
    expect((await rows())?.n).toBe(before?.n);
  });

  it("a nonce the engine didn't sign, an altered one or an expired one is refused", async () => {
    const real = await nonce();
    const [expiry = "", random = "", mac = ""] = real.split(".");
    const forged = [
      `${expiry}.${random}.${"A".repeat(mac.length)}`,
      `${(Number.parseInt(expiry, 36) + 60_000).toString(36)}.${random}.${mac}`,
      `${expiry}.${random.slice(1)}A.${mac}`,
      "x".repeat(43),
    ];
    for (const n of forged) {
      const key = await attestedKey(root, { challenge: await challengeFor(n) });
      const { res } = await start({ nonce: n, ...key });
      expect([n, res.status]).toEqual([n, 403]);
      expect((await json<{ error: string }>(res)).error).toMatch(/nonce is used or expired/);
    }
    // Signed by the engine, but expired, or for longer than a nonce lives.
    for (const at of [Date.now() - 1_000, Date.now() + 60 * 60_000]) {
      const body = `${at.toString(36)}.${random}`;
      const n = `${body}.${await mobileMac(env, "nonce", body)}`;
      const key = await attestedKey(root, { challenge: await challengeFor(n) });
      expect((await start({ nonce: n, ...key })).res.status).toBe(403);
    }
  });

  it("every wrong code counts against the offer, even past the caller's cap (review, second round)", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const attacker = "198.51.100.77";
    await pastTries(attacker, 9);
    const phones = await Promise.all(Array.from({ length: 4 }, () => phone()));
    const results = await Promise.all(
      phones.map((p, i) => start(p, { offer: { code: wrongFor(offer.code, i) } }, attacker)),
    );
    expect(results.map((r) => r.res.status)).toEqual([403, 403, 403, 403]);
    const row = await first<{ attempts: number }>(
      "SELECT attempts FROM core_pair_offers WHERE id = ?",
      offer.offerId,
    );
    expect(row?.attempts).toBe(4);
  });

  it("a right code whose offer closes on its way gets the wrong-code answer, and its nonce is spent", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const wrong = await start(await phone(), { offer: { code: wrongFor(offer.code, 1) } });
    const wrongBody = await json(wrong.res);
    // The offer closes between the right code's read and its batch.
    mobileTestSeams.beforeCommit = async (op) => {
      if (op !== "mobile.authStart") return;
      await env.DB.prepare("UPDATE core_pair_offers SET closed_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), offer.offerId)
        .run();
    };
    const p = await phone();
    const right = await start(p, { offer: { code: offer.code } });
    mobileTestSeams.beforeCommit = null;
    expect([right.res.status, wrong.res.status]).toEqual([403, 403]);
    expect(await json(right.res)).toEqual(wrongBody);
    expect(await tokens(w.userId)).toBe(0);
    // The nonce was spent before anything was decided: replaying it from elsewhere is refused.
    const replay = await start(p, { offer: { code: offer.code } }, "203.0.113.200");
    expect(replay.res.status).toBe(403);
    expect((await json<{ error: string }>(replay.res)).error).toMatch(/nonce is used/);
  });

  it("the answer to a wrong code doesn't say whether its tag is live", async () => {
    const w = await world();
    const offer = await ok<{ offerId: string; code: string }>("mobile.pairOffer", {}, w.human);
    const live = await start(await phone(), { offer: { code: wrongFor(offer.code, 3) } });
    // A tag no live offer has.
    const tags = await all<{ code_tag: string }>(
      "SELECT code_tag FROM core_pair_offers WHERE closed_at IS NULL AND consumed_at IS NULL",
    );
    const used = new Set(tags.map((t) => t.code_tag));
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const free =
      [...alphabet].flatMap((a) => [...alphabet].map((b) => a + b)).find((t) => !used.has(t)) ?? "";
    const dead = await start(await phone(), { offer: { code: `${free}ZZZZZZZZ` } });
    expect([live.res.status, dead.res.status]).toEqual([403, 403]);
    const a = await json(live.res);
    expect(a).toEqual(await json(dead.res));
    expect(JSON.stringify(a)).not.toMatch(/attemptsLeft/);
  });

  it("two offers never share a live tag, so wrong codes count against one offer only", async () => {
    const w = await world();
    const offers = await Promise.all(
      Array.from({ length: 5 }, () => ok<{ code: string }>("mobile.pairOffer", {}, w.human)),
    );
    const tags = offers.map((o) => o.code.slice(0, 2));
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("the caller hash is keyed by the engine's secret", async () => {
    const plain = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v4:192.0.2.9"));
    const unkeyed = [...new Uint8Array(plain).slice(0, 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const keyed = await callerOf("192.0.2.9");
    expect(keyed).not.toBe(unkeyed);
    const other = { ...env, RUNNER_CHANNEL_SECRET: "another-secret" } as Env;
    const req = new Request("https://x", { headers: { "cf-connecting-ip": "192.0.2.9" } });
    expect(await mobileCaller(req, other)).not.toBe(keyed);
  });

  it("an IPv6 caller is keyed by its /64", async () => {
    expect(ipv6Prefix64("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2");
    expect(ipv6Prefix64("2001:db8::1")).toBe("2001:db8:0:0");
    expect(await callerOf("2001:db8:1:2::5")).toBe(await callerOf("2001:db8:1:2:ffff::9"));
    expect(await callerOf("2001:db8:1:3::5")).not.toBe(await callerOf("2001:db8:1:2::5"));
  });
});

async function desktopSignIn(w: World) {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const { verifier, challenge } = await pkce();
  const started = await json<{ requestId: string }>(
    await post(
      "desktop/start",
      {
        deviceName: "Tim's Mac",
        publicKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        codeChallenge: challenge,
        state: "s".repeat(16),
      },
      undefined,
      {},
    ),
  );
  const approved = await ok<{ redirectUrl: string }>(
    "desktop.approveDevice",
    { requestId: started.requestId },
    w.human,
  );
  const code = new URL(approved.redirectUrl).searchParams.get("code") ?? "";
  const got = await json<{ token: string; deviceId: string }>(
    await post("desktop/exchange", { code, codeVerifier: verifier }, undefined, {}),
  );
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
  return { ...got, sign };
}

describe("deciding on the phone (criteria 4 and 5)", () => {
  it("merges, plan approvals and approving take a fingerprint; holding back is one tap", async () => {
    const w = await world();
    const { token, phone: p } = await browserSignIn(w);
    const workItemId = await newItem(w, token);

    // spec.approve: refused bare, decided with a proof.
    await gate(w, workItemId, "spec");
    const specInput = { workItemId };
    expect((await callOp(token, "spec.approve", specInput)).status).toBe(403);
    const specProof = await prove(token, p, "spec.approve", specInput);
    expect(specProof.summary).toMatch(/^Approve the spec for #\d+ "From the phone"$/);
    const approved = await callOp(token, "spec.approve", specInput, specProof);
    expect(approved.status).toBe(200);
    const audit = await first<{ origin: string }>(
      "SELECT origin FROM core_audit WHERE operation = 'spec.approve' AND work_item_id = ? AND outcome = 'ok'",
      workItemId,
    );
    expect(JSON.parse(String(audit?.origin))).toMatchObject({
      surface: "mobile",
      presence: { op: "spec.approve" },
    });

    // spec.requestChanges and review.sendBack: one tap.
    const second = await newItem(w, token, "Second");
    await gate(w, second, "spec");
    expect(
      (await callOp(token, "spec.requestChanges", { workItemId: second, note: "smaller" })).status,
    ).toBe(200);
    await gate(w, second, "merge", { headSha: "a".repeat(40) });
    expect(
      (
        await callOp(token, "review.sendBack", {
          workItemId: second,
          note: "tests",
          openedFullDiff: false,
        })
      ).status,
    ).toBe(200);

    // approval.decide: rejecting is one tap, approving takes a proof.
    const third = await newItem(w, token, "Third");
    const reject = await gate(w, third, "approval");
    expect(
      (await callOp(token, "approval.decide", { pendingActionId: reject, decision: "rejected" }))
        .status,
    ).toBe(200);
    const approve = await gate(w, third, "approval");
    const approveInput = { pendingActionId: approve, decision: "approved" };
    expect((await callOp(token, "approval.decide", approveInput)).status).toBe(403);
    const approvalProof = await prove(token, p, "approval.decide", approveInput);
    expect((await callOp(token, "approval.decide", approveInput, approvalProof)).status).toBe(200);
  });

  it("security, privacy and irreversible answers take a fingerprint; others are one tap", async () => {
    const w = await world();
    const { token, phone: p } = await browserSignIn(w);
    const workItemId = await newItem(w, token);
    const ordinary = await question(w, workItemId, "product");
    expect(
      (await callOp(token, "question.answer", { questionId: ordinary, answer: "b" })).status,
    ).toBe(200);
    for (const [domain, irreversible] of [
      ["security", false],
      ["privacy", false],
      ["product", true],
    ] as const) {
      const q = await question(w, workItemId, domain, irreversible);
      const input = { questionId: q, answer: "b" };
      const bare = await callOp(token, "question.answer", input);
      expect([domain, irreversible, bare.status]).toEqual([domain, irreversible, 403]);
      expect(await json(bare)).toMatchObject({ details: { presenceRequired: true } });
      // planning.answer refuses it the same way before anything else.
      const planning = await callOp(token, "planning.answer", input);
      expect(planning.status).toBe(403);
      const proof = await prove(token, p, "question.answer", input);
      expect((await callOp(token, "question.answer", input, proof)).status).toBe(200);
    }
    // An ordinary planning answer gets past the device check (this question isn't a planning one).
    const plain = await question(w, workItemId, "product");
    const res = await callOp(token, "planning.answer", { questionId: plain, answer: "a" });
    expect(await json(res)).toMatchObject({ code: "invalid_input" });
    // Bulk accept is one tap, and never covers the sensitive ones.
    expect((await callOp(token, "question.acceptDefaults", { workItemId })).status).toBe(200);
  });

  it("refuses replayed, wrong-op, wrong-digest, expired, other-device, revoked and approvals-off proofs", async () => {
    const w = await world();
    const { token, phone: p, deviceId } = await browserSignIn(w);
    const workItemId = await newItem(w, token);
    await gate(w, workItemId, "spec");
    const input = { workItemId };
    const used = await prove(token, p, "spec.approve", input);
    expect((await callOp(token, "spec.approve", input, used)).status).toBe(200);
    // Replayed.
    const item2 = await newItem(w, token, "Two");
    await gate(w, item2, "spec");
    expect((await callOp(token, "spec.approve", { workItemId: item2 }, used)).status).toBe(403);
    // Made for another op.
    const forOther = await prove(token, p, "review.merge", {
      workItemId: item2,
      openedFullDiff: true,
      headSha: "b".repeat(40),
    });
    expect((await callOp(token, "spec.approve", { workItemId: item2 }, forOther)).status).toBe(403);
    // Made for another input (digest).
    const forInput = await prove(token, p, "spec.approve", { workItemId });
    expect((await callOp(token, "spec.approve", { workItemId: item2 }, forInput)).status).toBe(403);
    // Expired.
    const late = await prove(token, p, "spec.approve", { workItemId: item2 });
    await env.DB.prepare("UPDATE core_presence_challenges SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), late.challengeId)
      .run();
    expect((await callOp(token, "spec.approve", { workItemId: item2 }, late)).status).toBe(403);
    // Signed by another phone's key.
    const stranger = await phone();
    const forged = await prove(token, stranger, "spec.approve", { workItemId: item2 });
    expect((await callOp(token, "spec.approve", { workItemId: item2 }, forged)).status).toBe(403);
    // A challenge of another device, presented by this one.
    const other = await browserSignIn(w);
    const theirs = await prove(other.token, other.phone, "spec.approve", { workItemId: item2 });
    expect((await callOp(token, "spec.approve", { workItemId: item2 }, theirs)).status).toBe(403);

    // Approvals off: no challenge, and an earlier one is refused at redemption.
    const early = await prove(token, p, "spec.approve", { workItemId: item2 });
    expect((await callOp(token, "device.update", { decides: false })).status).toBe(200);
    expect(
      (
        await callOp(token, "presence.challenge", {
          op: "spec.approve",
          input: { workItemId: item2 },
        })
      ).status,
    ).toBe(403);
    expect((await callOp(token, "spec.approve", { workItemId: item2 }, early)).status).toBe(403);
    // Turning them on takes this phone's fingerprint, for exactly that call.
    expect((await callOp(token, "device.update", { decides: true })).status).toBe(403);
    expect(
      (
        await ok<{ devices: { id: string; decides: boolean }[] }>("device.list", {}, w.human)
      ).devices.find((d) => d.id === deviceId)?.decides,
    ).toBe(false);
    const on = await prove(token, p, "device.update", { decides: true });
    expect(on.summary).toBe("Turn on fingerprint approvals on this device");
    expect((await callOp(token, "device.update", { decides: true }, on)).status).toBe(200);
    // The website can't turn them on.
    await expect(ok("device.update", { deviceId, decides: false }, w.human)).resolves.toBeTruthy();
    await expect(ok("device.update", { deviceId, decides: true }, w.human)).rejects.toThrow(
      /only from that device/,
    );

    // Revoked: the token fails, so does the proof.
    const pending = await prove(other.token, other.phone, "spec.approve", { workItemId: item2 });
    await ok("device.revoke", { deviceId: other.deviceId }, w.human);
    expect((await callOp(other.token, "spec.approve", { workItemId: item2 }, pending)).status).toBe(
      401,
    );
  });

  it("DESKTOP_ALLOW_SOFTWARE_KEYS lets a dev Mac decide, never a software-level phone", async () => {
    const w = await world();
    const soft = await browserSignIn(w, await phone({ deviceLocked: false }));
    expect(soft.keyStorage).toBe("software");
    engineEnv = { ...env, DESKTOP_ALLOW_SOFTWARE_KEYS: "1" };
    const workItemId = await newItem(w, soft.token);
    await gate(w, workItemId, "spec");
    const input = { workItemId };
    const proof = await prove(soft.token, soft.phone, "spec.approve", input);
    const res = await callOp(soft.token, "spec.approve", input, proof);
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toMatch(/can't approve/);
  });

  it("config changes and self-modify aren't decided on the phone, by any deciding operation", async () => {
    // Every operation that decides a pending action declares it in the registry (decidesPending):
    // decidePending refuses one that doesn't, and invoke() refuses any other write of a pending
    // action's status (core's invoke tests). A new one fails here until it has an input below,
    // and each is run from the phone against every kind it may not decide (third review of PR 1a).
    const human = OPERATIONS.filter((o) => o.decidesPending && o.actors.includes("human"))
      .map((o) => o.name)
      .sort();
    expect(human).toEqual([
      "approval.decide",
      "review.merge",
      "review.sendBack",
      "spec.approve",
      "spec.requestChanges",
    ]);

    const w = await world();
    const { token, phone: p } = await browserSignIn(w);
    const head = "c".repeat(40);
    type Case = {
      kind: "spec" | "merge" | "approval";
      input: (id: string, item: string) => object;
    };
    const cases: Record<string, Case[]> = {
      "approval.decide": [
        { kind: "approval", input: (id) => ({ pendingActionId: id, decision: "approved" }) },
        { kind: "approval", input: (id) => ({ pendingActionId: id, decision: "rejected" }) },
        { kind: "merge", input: (id) => ({ pendingActionId: id, decision: "rejected" }) },
      ],
      "review.merge": [
        {
          kind: "merge",
          input: (_, workItemId) => ({ workItemId, openedFullDiff: true, headSha: head }),
        },
      ],
      "review.sendBack": [
        {
          kind: "merge",
          input: (_, workItemId) => ({ workItemId, note: "no", openedFullDiff: true }),
        },
      ],
      "spec.approve": [{ kind: "spec", input: (_, workItemId) => ({ workItemId }) }],
      "spec.requestChanges": [
        { kind: "spec", input: (_, workItemId) => ({ workItemId, note: "smaller" }) },
      ],
    };
    const pending: { operation: string; risk: string }[] = [
      { operation: "config.save", risk: "self-modify" },
      { operation: "config.save", risk: "write" },
      { operation: "config.rollback", risk: "write" },
      { operation: "pr.merge", risk: "self-modify" },
      { operation: "pr.open", risk: "self-modify" },
    ];
    for (const op of human) {
      for (const c of cases[op] ?? []) {
        for (const pa of pending) {
          if (c.kind !== "approval" && CONFIG_OPS.includes(pa.operation)) continue;
          const workItemId = await newItem(w, token, "Touches .factory/");
          const id = await gate(w, workItemId, c.kind, { workItemId, headSha: head }, pa);
          const input = c.input(id, workItemId);
          const proof = await prove(token, p, op, input);
          const res = await callOp(token, op, input, proof);
          const label = [op, c.kind, pa, input];
          expect([...label, res.status]).toEqual([...label, 403]);
          expect((await json<{ error: string }>(res)).error).toMatch(
            /approve this on the desktop app or the website/,
          );
          const row = await first<{ status: string }>(
            "SELECT status FROM core_pending_actions WHERE id = ?",
            id,
          );
          expect([...label, row?.status]).toEqual([...label, "pending"]);
        }
      }
    }
    // The website still decides one.
    const item = await newItem(w, token);
    const id = await gate(w, item, "approval", {}, { operation: "config.save", risk: "write" });
    expect(
      (await call("approval.decide", { pendingActionId: id, decision: "rejected" }, w.human))
        .status,
    ).toBe("ok");
  });

  it("the phone can't cancel an item while a config change or a self-modify action waits on it", async () => {
    // Cancelling rejects the item's open gates, so from the phone it would decide what the phone
    // may not (third review of PR 1a): refused, and the gate stays open.
    const w = await world();
    const { token } = await browserSignIn(w);
    const waiting = async (pa: { operation: string; risk: string }) => {
      const workItemId = await newItem(w, token, "Touches .factory/");
      await env.DB.prepare("UPDATE core_work_items SET status = 'waiting' WHERE id = ?")
        .bind(workItemId)
        .run();
      return { workItemId, id: await gate(w, workItemId, "approval", {}, pa) };
    };
    for (const pa of [
      { operation: "config.save", risk: "write" },
      { operation: "config.rollback", risk: "write" },
      { operation: "pr.open", risk: "self-modify" },
    ]) {
      const { workItemId, id } = await waiting(pa);
      const res = await callOp(token, "workItem.cancel", { workItemId, reason: "from the phone" });
      expect([pa, res.status]).toEqual([pa, 403]);
      expect(await json(res)).toMatchObject({
        error: expect.stringMatching(/cancel it on the desktop app or the website/),
        details: { decideElsewhere: true },
      });
      const row = await first<{ status: string }>(
        "SELECT status FROM core_pending_actions WHERE id = ?",
        id,
      );
      expect([pa, row?.status]).toEqual([pa, "pending"]);
    }
    // An ordinary gate: the phone cancels the item and the gate closes with it.
    const plain = await waiting({ operation: "pr.open", risk: "write" });
    const res = await callOp(token, "workItem.cancel", { workItemId: plain.workItemId });
    expect(res.status).toBe(200);
    const row = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      plain.id,
    );
    expect(row?.status).toBe("rejected");
    // The website still cancels one.
    const web = await waiting({ operation: "config.save", risk: "self-modify" });
    expect((await call("workItem.cancel", { workItemId: web.workItemId }, w.human)).status).toBe(
      "ok",
    );
  });

  it("a phone registered with approvals off can't ask for a challenge", async () => {
    const w = await world();
    const off = await browserSignIn(w, undefined, false);
    const workItemId = await newItem(w, off.token);
    const res = await callOp(off.token, "presence.challenge", {
      op: "spec.approve",
      input: { workItemId },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ details: { approvalsOff: true } });
  });

  it("review.merge is for one commit: a stale headSha is refused and nothing merges (criterion 5)", async () => {
    const w = await world();
    const { token, phone: p } = await browserSignIn(w);
    const workItemId = await newItem(w, token, "Guard the tests in verify");
    const head = "3f2a91c".padEnd(40, "0");
    const pa = await gate(w, workItemId, "merge", {
      workItemId,
      headSha: head,
      touchesFactoryConfig: false,
    });
    // The head's review packet: with none, the merge gate refuses (ADR 0501, fifth review).
    await env.DB.prepare(
      "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, created_at) VALUES (?, ?, ?, 'pass', ?)",
    )
      .bind(uid("rp_"), workItemId, head, new Date().toISOString())
      .run();
    // The phone always names the commit.
    const noSha = { workItemId, openedFullDiff: true };
    const missing = await callOp(
      token,
      "review.merge",
      noSha,
      await prove(token, p, "review.merge", noSha),
    );
    expect(missing.status).toBe(400);
    // A stale one.
    const stale = { workItemId, openedFullDiff: true, headSha: "1".repeat(40) };
    const staleProof = await prove(token, p, "review.merge", stale);
    const refused = await callOp(token, "review.merge", stale, staleProof);
    expect(refused.status).toBe(409);
    expect((await json<{ error: string }>(refused)).error).toMatch(
      /A new push withdrew this approval/,
    );
    expect(
      await first<{ status: string }>("SELECT status FROM core_pending_actions WHERE id = ?", pa),
    ).toEqual({
      status: "pending",
    });
    // The right one, with the commit in the prompt.
    const fresh = { workItemId, openedFullDiff: true, headSha: head };
    const proof = await prove(token, p, "review.merge", fresh);
    expect(proof.summary).toBe('Merge 3f2a91c "Guard the tests in verify" into main');
    // Merging without checks the runner couldn't run is refused on the phone, in the engine: no
    // challenge is issued for it, and a proof for the plain merge doesn't carry it (fifth review).
    const without = { ...fresh, mergeWithoutChecks: true };
    const challenge = await callOp(token, "presence.challenge", {
      op: "review.merge",
      input: without,
    });
    expect(challenge.status).toBe(403);
    const forced = await callOp(token, "review.merge", without, proof);
    expect(forced.status).toBe(403);
    expect(
      await first<{ status: string }>("SELECT status FROM core_pending_actions WHERE id = ?", pa),
    ).toEqual({ status: "pending" });
    const merged = await callOp(token, "review.merge", fresh, proof);
    expect(merged.status).toBe(200);
    expect(
      await first<{ status: string }>("SELECT status FROM core_pending_actions WHERE id = ?", pa),
    ).toEqual({
      status: "approved",
    });
  });
});

describe("tokens, revocation and the door (criterion 6)", () => {
  it("a phone token is on the mobile surface; revoking the phone fails its next call", async () => {
    const w = await world();
    const { token, deviceId } = await browserSignIn(w);
    const workItemId = await newItem(w, token);
    const audited = await first<{ origin: string }>(
      "SELECT origin FROM core_audit WHERE operation = 'workItem.create' AND work_item_id = ?",
      workItemId,
    );
    expect(JSON.parse(String(audited?.origin))).toMatchObject({ surface: "mobile", deviceId });
    const listed = await json<{
      result: { devices: { id: string; platform: string; current: boolean }[] };
    }>(await callOp(token, "device.list", {}));
    expect(listed.result.devices.find((d) => d.id === deviceId)).toMatchObject({
      platform: "android",
      current: true,
    });
    // The desktop's old name lists it too.
    const old = await ok<{ devices: { id: string }[] }>("desktopDevice.list", {}, w.human);
    expect(old.devices.map((d) => d.id)).toContain(deviceId);
    // Sign out: the phone revokes itself.
    expect((await callOp(token, "device.revoke", { deviceId })).status).toBe(200);
    const after = await callOp(token, "inbox.list", {});
    expect(after.status).toBe(401);
    expect(await json(after)).toMatchObject({ code: "unauthenticated" });
  });

  it("removing a phone while its approval is on its way refuses the approval (review, second round)", async () => {
    const w = await world();
    const { token, phone: p, deviceId } = await browserSignIn(w);
    const workItemId = await newItem(w, token);
    const pa = await gate(w, workItemId, "spec");
    const input = { workItemId };
    const proof = await prove(token, p, "spec.approve", input);
    // The phone is removed after the token was checked, before the decision commits.
    mobileTestSeams.beforeCommit = async (op) => {
      if (op !== "spec.approve") return;
      await env.DB.prepare("UPDATE core_desktop_devices SET revoked_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), deviceId)
        .run();
    };
    const res = await callOp(token, "spec.approve", input, proof);
    mobileTestSeams.beforeCommit = null;
    expect(res.status).toBe(403);
    expect((await json<{ error: string }>(res)).error).toMatch(/device was removed/);
    expect(
      await first<{ status: string }>("SELECT status FROM core_pending_actions WHERE id = ?", pa),
    ).toEqual({ status: "pending" });
  });

  it("renews with a fingerprint: a new token, the old one revoked", async () => {
    const w = await world();
    const { token, phone: p } = await browserSignIn(w);
    expect((await callOp(token, "mobile.renew", {})).status).toBe(403);
    const proof = await prove(token, p, "mobile.renew", {});
    const res = await callOp(token, "mobile.renew", {}, proof);
    expect(res.status).toBe(200);
    const { result } = await json<{ result: { token: string } }>(res);
    expect(result.token).toMatch(/^sfm_/);
    expect((await callOp(token, "inbox.list", {})).status).toBe(401);
    expect((await callOp(result.token, "inbox.list", {})).status).toBe(200);
  });

  it("a phone that can't decide still renews with a fingerprint (approvals off, or software)", async () => {
    const w = await world();
    const off = await browserSignIn(w, undefined, false);
    const soft = await browserSignIn(w, await phone({ verifiedBootState: 2 }));
    expect(soft.keyStorage).toBe("software");
    for (const got of [off, soft]) {
      // It can't decide...
      const workItemId = await newItem(w, got.token);
      await gate(w, workItemId, "spec");
      expect((await callOp(got.token, "spec.approve", { workItemId })).status).toBe(403);
      // ...but its own key renews its token.
      const proof = await prove(got.token, got.phone, "mobile.renew", {});
      const res = await callOp(got.token, "mobile.renew", {}, proof);
      expect(res.status).toBe(200);
      const { result } = await json<{ result: { token: string } }>(res);
      expect((await callOp(result.token, "inbox.list", {})).status).toBe(200);
      expect((await callOp(got.token, "inbox.list", {})).status).toBe(401);
      // A renewal proof is for the renewal only.
      const reused = await callOp(result.token, "spec.approve", { workItemId }, proof);
      expect(reused.status).toBe(403);
    }
  });

  it("revoking a phone closes its live socket at once", async () => {
    const w = await world();
    const { token, deviceId } = await browserSignIn(w);
    const live = await worker.fetch(
      new Request("https://sf-engine.example/client/v1/live", {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}`, ...PROTOCOL },
      }),
      env,
    );
    expect(live.status).toBe(101);
    const ws = live.webSocket as WebSocket;
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener("close", (e) => resolve(e.code)),
    );
    ws.accept();
    // Revoked from the website, not by the phone.
    await ok("device.revoke", { deviceId }, w.human);
    const code = await Promise.race([
      closed,
      new Promise<string>((resolve) => setTimeout(() => resolve("still open"), 2_000)),
    ]);
    expect(code).toBe(4401);
  });

  it("a phone below the minimum protocol gets 426; a CLI or desktop token isn't affected", async () => {
    const w = await world();
    const { token } = await browserSignIn(w);
    const old: Record<string, string>[] = [{}, { "x-sf-client-protocol": "0" }];
    for (const headers of old) {
      expect((await post("call", { op: "inbox.list", input: {} }, token, headers)).status).toBe(
        426,
      );
      expect((await post("mobile/nonce", {}, undefined, headers)).status).toBe(426);
    }
    const mac = await desktopSignIn(w);
    expect((await post("call", { op: "inbox.list", input: {} }, mac.token, {})).status).toBe(200);
    // The live socket takes a phone token.
    const live = await worker.fetch(
      new Request("https://sf-engine.example/client/v1/live", {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}`, ...PROTOCOL },
      }),
      env,
    );
    expect(live.status).toBe(101);
    live.webSocket?.accept();
    live.webSocket?.close();
    // The web terminal stays on the desktop (typing into a terminal is out of the phone's scope).
    const terminal = await worker.fetch(
      new Request(
        `https://sf-engine.example/client/v1/terminal/wi_${"0".repeat(32)}/run_${"0".repeat(32)}`,
        { headers: { upgrade: "websocket", authorization: `Bearer ${token}`, ...PROTOCOL } },
      ),
      env,
    );
    expect(terminal.status).toBe(403);
  });

  it("prunes old nonces, offers and typed-code tries", async () => {
    const w = await world();
    await start(await phone());
    await ok("mobile.pairOffer", {}, w.human);
    await env.DB.prepare("INSERT INTO core_pair_code_tries (id, at, ok) VALUES (?, ?, 0)")
      .bind(uid("t"), new Date(Date.now() - 3 * 86_400_000).toISOString())
      .run();
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await env.DB.prepare("UPDATE core_mobile_nonces SET expires_at = ?").bind(old).run();
    await env.DB.prepare("UPDATE core_pair_offers SET expires_at = ?").bind(old).run();
    await pruneChannelStore(env.DB);
    const left = await first<{ n: number; o: number; t: number }>(
      "SELECT (SELECT COUNT(*) FROM core_mobile_nonces) AS n, (SELECT COUNT(*) FROM core_pair_offers) AS o, (SELECT COUNT(*) FROM core_pair_code_tries WHERE at < datetime('now', '-2 days')) AS t",
    );
    expect(left).toEqual({ n: 0, o: 0, t: 0 });
  });

  it("the signing certificate the tests trust is the one in vitest.config.ts", () => {
    expect(env.MOBILE_SIGNING_CERTS.replaceAll(":", "").toLowerCase()).toBe(TEST_SIGNING_CERT);
  });
});
