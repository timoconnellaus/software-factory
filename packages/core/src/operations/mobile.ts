// The phone app's sign-in and pairing (ADR 0541, spec 60 PR 1a).
//
// The phone makes an EC P-256 key in Android Keystore (StrongBox or the TEE, a fingerprint for
// every use), generated with an attestation challenge derived from a one-use nonce
// (mobile.nonce). It sends the key's certificate chain with mobile.authStart, and the engine checks
// the attestation (attestation/android.ts) before anything is stored. Then one of two ways in, each
// ending with a person's approval and exactly one `sfm_` token:
// - **Browser**: authStart returns the website page where the person signs in and approves
//   (mobile.approveDevice, browser-only). The site sends the browser to the App Link
//   `/mobile/callback?code=…&state=…`, and the phone trades the code and its PKCE verifier for a
//   token (mobile.authExchange).
// - **QR or typed code**: a person signed in on the website, or on the desktop with Touch ID, makes
//   a pair offer (mobile.pairOffer). The offer *is* the approval: one use, 5 minutes, stored only as
//   hashes. The phone sends its secret (from the QR) or the typed code with authStart, gets the
//   one-time code back directly, and exchanges it as above. Five wrong typed codes close an offer,
//   and the engine takes at most 30 typed codes an hour from anyone.
//
// The phone isn't anyone before it signs in, so the client door calls mobile.nonce,
// mobile.authStart and mobile.authExchange unsigned, as MOBILE_DEVICE_ACTOR.
import { z } from "zod";
import type { Actor } from "../actors.ts";
import {
  AttestationError,
  attestationChallenge,
  MOBILE_PACKAGE,
  type VerifiedAttestation,
} from "../attestation/android.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  DESKTOP_PENDING_LIMIT,
  deviceName,
  expired,
  keyFingerprint,
  type PublicKeyJwk,
  pkceChallenge,
} from "./desktop.ts";
import { attestationSummary, parseAttestation } from "./device.ts";
import { randomToken, sha256Hex } from "./onboarding.ts";

/** The actor the client door uses for the phone's three unsigned sign-in calls. */
export const MOBILE_DEVICE_ACTOR: Actor = { type: "runner", id: "mobile-device-login" };
/** Where a person approves a phone's browser sign-in on the website. */
export const MOBILE_APPROVE_PATH = "/mobile/connect";
/** The App Link the website sends the browser back to (verified by assetlinks.json). */
export const MOBILE_CALLBACK_PATH = "/mobile/callback";
/** The App Link a pair offer's QR code holds; its secret is in the fragment. */
export const MOBILE_PAIR_PATH = "/mobile/pair";
/** Phone tokens start with this, so they're recognisable in a leak scan. */
export const MOBILE_TOKEN_PREFIX = "sfm_";
/** A phone token lasts this long; in its last week the app renews it with a fingerprint. */
export const MOBILE_TOKEN_TTL_MS = 30 * 24 * 3_600_000;
/** A nonce, an offer and a sign-in request each live this long. */
export const MOBILE_NONCE_TTL_MS = 5 * 60_000;
export const PAIR_OFFER_TTL_MS = 5 * 60_000;
export const MOBILE_AUTH_TTL_MS = 10 * 60_000;
/** Wrong typed codes that close an offer, and typed codes the engine takes an hour from anyone. */
export const PAIR_CODE_ATTEMPTS = 5;
export const PAIR_CODE_TRIES_PER_HOUR = 30;
/** At most this many unspent nonces at once (mobile/nonce is unauthenticated). */
export const MOBILE_NONCE_LIMIT = 200;
/** At most this many live offers per person. */
export const PAIR_OFFER_LIMIT = 5;

/**
 * Crockford base32 for typed codes: no I, L, O or U. Ten characters: two name the offer (so a wrong
 * code counts against it), eight are the secret (40 bits, against 5 tries per offer).
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const TAG_LENGTH = 2;

function randomCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}

/** `abcde-fghjk`, `ABCDEFGHJK`, with I→1, L→1, O→0 → `ABCDEFGHJK`. */
export function normalizePairCode(text: string): string {
  return text
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-Z]/g, "");
}

/** `ABCDEFGHJK` → `ABCDE-FGHJK`, as the screens show it. */
export const formatPairCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

/** The attestation checks' settings and the revocation list (sf-engine supplies them). */
export interface MobileAttestationService {
  /** SHA-256 of the signing certificates the app may be signed with (MOBILE_SIGNING_CERTS). */
  signingCerts: readonly string[];
  /** Google's revocation list, cached for a day. Throws when it can't be had: sign-in is refused. */
  revoked(): Promise<ReadonlySet<string>>;
  /** Checks a chain. sf-engine passes Google's roots; tests may pass a test root here. */
  verify(
    chain: readonly string[],
    expected: { challenge: Uint8Array; revoked: ReadonlySet<string>; now: number },
  ): Promise<VerifiedAttestation>;
}

const b64url = /^[A-Za-z0-9_-]+$/;
const requestId = z.string().regex(/^dar_[0-9a-f]{32}$/);
const offerId = z.string().regex(/^pof_[0-9a-f]{32}$/);
const certificate = z.string().min(100).max(16_000);
const statusEnum = z.enum(["pending", "approved", "denied", "consumed", "expired"]);

function requireMobileActor(ctx: HandlerContext) {
  if (ctx.actor.id !== MOBILE_DEVICE_ACTOR.id) {
    throw new OperationError("forbidden", "only the phone app's sign-in calls this");
  }
}

const baseUrl = (ctx: HandlerContext) => (ctx.services.publicBaseUrl ?? "").replace(/\/+$/, "");

async function verifyAttestation(
  ctx: HandlerContext,
  nonce: string,
  chain: readonly string[],
): Promise<VerifiedAttestation> {
  const service = ctx.services.mobileAttestation;
  if (!service) {
    throw new OperationError("unavailable", "phone sign-in isn't set up on this engine");
  }
  let revoked: ReadonlySet<string>;
  try {
    revoked = await service.revoked();
  } catch {
    throw new OperationError(
      "unavailable",
      "Google's attestation revocation list can't be checked right now: try again in a minute",
    );
  }
  try {
    return await service.verify(chain, {
      challenge: await attestationChallenge(nonce),
      revoked,
      now: Date.parse(ctx.now),
    });
  } catch (error) {
    if (error instanceof AttestationError) {
      throw new OperationError(
        "forbidden",
        `this phone's key attestation was refused: ${error.message}`,
        {
          attestation: error.reason,
        },
      );
    }
    throw error;
  }
}

export const mobileNonce = defineOperation({
  name: "mobile.nonce",
  description:
    "A one-use nonce (5 minutes) for the phone's key attestation (ADR 0541): the phone generates its Keystore key with SHA-256 of this nonce as the attestation challenge, then sends both with mobile.authStart. Stored only as a hash. Called unsigned by sf-engine's client door.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({}),
  output: z.object({ nonce: z.string(), expiresAt: z.string() }),
  redact: { output: (o) => ({ ...o, nonce: "[redacted]" }) },
  async handler(_input, ctx) {
    requireMobileActor(ctx);
    const live = await ctx.db
      .selectFrom("core_mobile_nonces")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("consumed_at", "is", null)
      .where("expires_at", ">", ctx.now)
      .executeTakeFirst();
    if (Number(live?.n ?? 0) >= MOBILE_NONCE_LIMIT) {
      throw new OperationError(
        "unavailable",
        "too many sign-ins at once: try again in a few minutes",
      );
    }
    const nonce = randomToken();
    const expiresAt = new Date(Date.parse(ctx.now) + MOBILE_NONCE_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_mobile_nonces").values({
        nonce_hash: await sha256Hex(nonce),
        created_at: ctx.now,
        expires_at: expiresAt,
        consumed_at: null,
      }),
    );
    return { nonce, expiresAt };
  },
});

const startOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    requestId: z.string(),
    approveUrl: z.string(),
    expiresAt: z.string(),
    keyStorage: z.string(),
  }),
  z.object({
    status: z.literal("approved"),
    requestId: z.string(),
    /** The one-time code for mobile.authExchange (the offer was the approval). */
    code: z.string(),
    expiresAt: z.string(),
    keyStorage: z.string(),
  }),
  /** A wrong typed code: counted against the offer it names (the door answers 403). */
  z.object({ status: z.literal("refused"), error: z.string(), attemptsLeft: z.number() }),
]);

export const mobileAuthStart = defineOperation({
  name: "mobile.authStart",
  description:
    "Start a phone sign-in (ADR 0541): the nonce from mobile.nonce, the Keystore key's attestation chain (base64 DER, leaf first), a device name, a PKCE S256 challenge and a state. The engine checks the attestation (Google's pinned roots and revocation list, the challenge, a hardware P-256 key bound to a fingerprint for every use, our package and signing certificate) and refuses the sign-in if it fails; a phone whose boot isn't verified or whose bootloader is unlocked registers but can't approve. Without an offer it returns the website page where a person approves (10 minutes). With a pair offer (the QR's offerId and secret, or the typed code) it is already approved and returns the one-time code. Called unsigned by sf-engine's client door.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    nonce: z.string().min(20).max(200),
    attestationChain: z.array(certificate).min(2).max(10),
    deviceName,
    codeChallenge: z.string().regex(b64url).length(43),
    state: z.string().regex(b64url).min(16).max(200),
    offer: z
      .union([
        z.object({ offerId, secret: z.string().min(20).max(200) }),
        z.object({ code: z.string().min(CODE_LENGTH).max(20) }),
      ])
      .optional(),
  }),
  output: startOutput,
  redact: {
    input: (i) => ({
      deviceName: i.deviceName,
      attestationChain: `[${i.attestationChain.length} certificates]`,
      offer: i.offer
        ? "offerId" in i.offer
          ? { offerId: i.offer.offerId }
          : { code: "[redacted]" }
        : null,
      nonce: "[redacted]",
    }),
    output: (o) => ("code" in o ? { ...o, code: "[redacted]" } : o),
  },
  async handler(input, ctx) {
    requireMobileActor(ctx);
    const nonceHash = await sha256Hex(input.nonce);
    const nonce = await ctx.db
      .selectFrom("core_mobile_nonces")
      .selectAll()
      .where("nonce_hash", "=", nonceHash)
      .executeTakeFirst();
    if (!nonce || nonce.consumed_at || expired(ctx, nonce)) {
      throw new OperationError("forbidden", "this sign-in's nonce is used or expired: start again");
    }
    const pending = await ctx.db
      .selectFrom("core_desktop_auth_requests")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("status", "=", "pending")
      .where("expires_at", ">", ctx.now)
      .executeTakeFirst();
    if (Number(pending?.n ?? 0) >= DESKTOP_PENDING_LIMIT) {
      throw new OperationError(
        "unavailable",
        "too many sign-ins are waiting: try again in a few minutes",
      );
    }
    // A typed code is counted before the attestation is even looked at: the cap holds whatever
    // the phone sends.
    let offer: { id: string; user_id: string } | null = null;
    if (input.offer && "code" in input.offer) {
      const found = await redeemTypedCode(ctx, normalizePairCode(input.offer.code));
      if ("refused" in found) return found.refused;
      offer = found.offer;
    }

    const attested = await verifyAttestation(ctx, input.nonce, input.attestationChain);

    if (input.offer && "offerId" in input.offer) {
      const row = await ctx.db
        .selectFrom("core_pair_offers")
        .selectAll()
        .where("id", "=", input.offer.offerId)
        .executeTakeFirst();
      if (
        !row ||
        row.secret_hash !== (await sha256Hex(input.offer.secret)) ||
        row.consumed_at ||
        row.closed_at ||
        expired(ctx, row)
      ) {
        throw new OperationError(
          "denied",
          "this pairing code is used, expired or wrong: make a new one on the desktop or the website",
        );
      }
      offer = row;
    }

    ctx.write(
      ctx.db
        .updateTable("core_mobile_nonces")
        .set({ consumed_at: ctx.now })
        .where("nonce_hash", "=", nonceHash)
        .where("consumed_at", "is", null),
    );
    ctx.guardChanged("use the nonce once");
    if (offer) {
      ctx.write(
        ctx.db
          .updateTable("core_pair_offers")
          .set({ consumed_at: ctx.now })
          .where("id", "=", offer.id)
          .where("consumed_at", "is", null)
          .where("closed_at", "is", null),
      );
      ctx.guardChanged("use the offer once");
    }

    const id = newId("desktopAuthRequest");
    const expiresAt = new Date(Date.parse(ctx.now) + MOBILE_AUTH_TTL_MS).toISOString();
    const code = offer ? randomToken() : null;
    ctx.write(
      ctx.db.insertInto("core_desktop_auth_requests").values({
        id,
        code_challenge: input.codeChallenge,
        device_name: input.deviceName,
        public_key: JSON.stringify(attested.publicKey),
        key_storage: attested.keyStorage,
        platform: "android",
        attestation: JSON.stringify(attested.record),
        offer_id: offer?.id ?? null,
        state: input.state,
        status: offer ? "approved" : "pending",
        user_id: offer?.user_id ?? null,
        code_hash: code ? await sha256Hex(code) : null,
        device_id: null,
        created_at: ctx.now,
        expires_at: expiresAt,
        decided_at: offer ? ctx.now : null,
        consumed_at: null,
      }),
    );
    if (offer && code) {
      ctx.change({
        entity: "desktop_auth_request",
        id,
        after: { status: "approved", by: offer.user_id, offer: offer.id, device: input.deviceName },
      });
      return {
        status: "approved" as const,
        requestId: id,
        code,
        expiresAt,
        keyStorage: attested.keyStorage,
      };
    }
    return {
      status: "pending" as const,
      requestId: id,
      approveUrl: `${baseUrl(ctx)}${MOBILE_APPROVE_PATH}?request=${id}`,
      expiresAt,
      keyStorage: attested.keyStorage,
    };
  },
});

/** Finds the live offer a typed code names, counting the try (and a wrong one against it). */
async function redeemTypedCode(
  ctx: HandlerContext,
  code: string,
): Promise<
  | { offer: { id: string; user_id: string } }
  | { refused: { status: "refused"; error: string; attemptsLeft: number } }
> {
  const hourAgo = new Date(Date.parse(ctx.now) - 3_600_000).toISOString();
  const tries = await ctx.db
    .selectFrom("core_pair_code_tries")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("at", ">", hourAgo)
    .executeTakeFirst();
  if (Number(tries?.n ?? 0) >= PAIR_CODE_TRIES_PER_HOUR) {
    throw new OperationError(
      "unavailable",
      "too many typed codes this hour: scan the QR code instead, or try again later",
    );
  }
  const live = await ctx.db
    .selectFrom("core_pair_offers")
    .selectAll()
    .where("code_tag", "=", code.slice(0, TAG_LENGTH))
    .where("consumed_at", "is", null)
    .where("closed_at", "is", null)
    .where("expires_at", ">", ctx.now)
    .execute();
  const hash = await sha256Hex(code);
  const match = code.length === CODE_LENGTH ? live.find((o) => o.code_hash === hash) : undefined;
  ctx.write(
    ctx.db
      .insertInto("core_pair_code_tries")
      .values({ id: crypto.randomUUID(), at: ctx.now, ok: match ? 1 : 0 }),
  );
  if (match) return { offer: match };
  let attemptsLeft = 0;
  for (const o of live) {
    const attempts = o.attempts + 1;
    attemptsLeft = Math.max(attemptsLeft, PAIR_CODE_ATTEMPTS - attempts);
    ctx.write(
      ctx.db
        .updateTable("core_pair_offers")
        .set({
          attempts,
          ...(attempts >= PAIR_CODE_ATTEMPTS ? { closed_at: ctx.now } : {}),
        })
        .where("id", "=", o.id),
    );
  }
  return {
    refused: {
      status: "refused",
      error:
        attemptsLeft > 0
          ? "that code isn't right: check it against the screen"
          : "that code isn't right, and the offer is closed: make a new one",
      attemptsLeft,
    },
  };
}

async function phoneRequest(ctx: HandlerContext, id: string) {
  const row = await ctx.db
    .selectFrom("core_desktop_auth_requests")
    .selectAll()
    .where("id", "=", id)
    .where("platform", "=", "android")
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "no such sign-in: start it again on the phone");
  return row;
}

export const mobileAuthLookup = defineOperation({
  name: "mobile.authLookup",
  description:
    "What a phone sign-in is waiting for, so the website can show it before a person approves: the phone's name, where its key lives (StrongBox, the TEE, or software if it can't approve), its attested boot state and patch level, the key's fingerprint, its status and expiry.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ requestId }),
  output: z.object({
    requestId: z.string(),
    deviceName: z.string(),
    keyStorage: z.string(),
    keyFingerprint: z.string(),
    attestation: attestationSummary,
    status: statusEnum,
    expiresAt: z.string(),
  }),
  async handler(input, ctx) {
    const row = await phoneRequest(ctx, input.requestId);
    return {
      requestId: row.id,
      deviceName: row.device_name,
      keyStorage: row.key_storage,
      keyFingerprint: await keyFingerprint(JSON.parse(row.public_key) as PublicKeyJwk),
      attestation: parseAttestation(row.attestation),
      status: row.status === "pending" && expired(ctx, row) ? ("expired" as const) : row.status,
      expiresAt: row.expires_at,
    };
  },
});

export const mobileApproveDevice = defineOperation({
  name: "mobile.approveDevice",
  description:
    "Approve a phone's browser sign-in (ADR 0541): the phone gets a token that acts as you, and can decide a merge, a plan or a policy change only with a fingerprint each time. Returns the App Link that hands the one-time code back to the phone. Browser-only, for a pending, unexpired request.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  input: z.object({ requestId }),
  output: z.object({ approved: z.boolean(), redirectUrl: z.string() }),
  redact: { output: (o) => ({ ...o, redirectUrl: "[redacted]" }) },
  async handler(input, ctx) {
    const row = await phoneRequest(ctx, input.requestId);
    if (row.status !== "pending") {
      throw new OperationError(
        "conflict",
        "this sign-in was already decided: start again on the phone",
      );
    }
    if (expired(ctx, row)) {
      throw new OperationError("conflict", "this sign-in expired: start again on the phone");
    }
    const code = randomToken();
    ctx.write(
      ctx.db
        .updateTable("core_desktop_auth_requests")
        .set({
          status: "approved",
          user_id: ctx.actor.id,
          code_hash: await sha256Hex(code),
          decided_at: ctx.now,
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending"),
    );
    ctx.guardChanged("decide once");
    ctx.change({
      entity: "desktop_auth_request",
      id: row.id,
      after: { status: "approved", by: ctx.actor.id, device: row.device_name },
    });
    const query = new URLSearchParams({ code, state: row.state });
    return { approved: true, redirectUrl: `${baseUrl(ctx)}${MOBILE_CALLBACK_PATH}?${query}` };
  },
});

export const mobileDenyDevice = defineOperation({
  name: "mobile.denyDevice",
  description:
    "Deny a phone sign-in you didn't start: it can't be exchanged for a token. Browser-only.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  input: z.object({ requestId }),
  output: z.object({ denied: z.boolean() }),
  async handler(input, ctx) {
    const row = await phoneRequest(ctx, input.requestId);
    if (row.status !== "pending")
      throw new OperationError("conflict", "this sign-in was already decided");
    ctx.write(
      ctx.db
        .updateTable("core_desktop_auth_requests")
        .set({ status: "denied", user_id: ctx.actor.id, decided_at: ctx.now })
        .where("id", "=", row.id)
        .where("status", "=", "pending"),
    );
    ctx.guardChanged("decide once");
    return { denied: true };
  },
});

/** Mints a phone token for a device. */
async function mintMobileToken(
  ctx: HandlerContext,
  userId: string,
  deviceId: string,
  name: string,
) {
  const token = `${MOBILE_TOKEN_PREFIX}${randomToken(32)}`;
  const tokenId = newId("cliToken");
  const expiresAt = new Date(Date.parse(ctx.now) + MOBILE_TOKEN_TTL_MS).toISOString();
  ctx.write(
    ctx.db.insertInto("core_cli_tokens").values({
      id: tokenId,
      token_hash: await sha256Hex(token),
      user_id: userId,
      name,
      scope: "write",
      kind: "mobile",
      device_id: deviceId,
      created_at: ctx.now,
      expires_at: expiresAt,
      revoked_at: null,
    }),
  );
  return { token, tokenId, expiresAt };
}

export const mobileAuthExchange = defineOperation({
  name: "mobile.authExchange",
  description:
    "The phone trades the one-time code (from the App Link, or from mobile.authStart with a pair offer) and its PKCE verifier for a phone token (30 days) bound to the device it registered. Once only. `decides: false` registers the phone with fingerprint approvals off. Called unsigned by sf-engine's client door.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    code: z.string().min(20).max(200),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    decides: z.boolean().optional(),
  }),
  output: z.object({
    token: z.string(),
    tokenId: z.string(),
    deviceId: z.string(),
    expiresAt: z.string(),
    login: z.string().nullable(),
    keyStorage: z.string(),
    decides: z.boolean(),
  }),
  redact: {
    input: (i) => ({ code: "[redacted]", codeVerifier: "[redacted]", decides: i.decides }),
    output: (o) => ({ ...o, token: "[redacted]" }),
  },
  async handler(input, ctx) {
    requireMobileActor(ctx);
    const refused = () =>
      new OperationError("denied", "this sign-in can't be completed: start again on the phone");
    const row = await ctx.db
      .selectFrom("core_desktop_auth_requests")
      .selectAll()
      .where("code_hash", "=", await sha256Hex(input.code))
      .where("platform", "=", "android")
      .executeTakeFirst();
    if (row?.status !== "approved" || !row.user_id || expired(ctx, row)) throw refused();
    if ((await pkceChallenge(input.codeVerifier)) !== row.code_challenge) throw refused();
    const user = await ctx.db
      .selectFrom("core_user")
      .select(["id", "github_login"])
      .where("id", "=", row.user_id)
      .executeTakeFirst();
    if (!user) throw refused();

    const deviceId = newId("desktopDevice");
    const decides = input.decides ?? true;
    ctx.write(
      ctx.db
        .updateTable("core_desktop_auth_requests")
        .set({ status: "consumed", consumed_at: ctx.now, device_id: deviceId })
        .where("id", "=", row.id)
        .where("status", "=", "approved"),
    );
    ctx.guardChanged("exchange the code once");
    ctx.write(
      ctx.db.insertInto("core_desktop_devices").values({
        id: deviceId,
        user_id: user.id,
        name: row.device_name,
        public_key: row.public_key,
        key_storage: row.key_storage,
        platform: "android",
        attestation: row.attestation,
        decides: decides ? 1 : 0,
        created_at: ctx.now,
        last_seen_at: null,
        revoked_at: null,
      }),
    );
    if (row.offer_id) {
      ctx.write(
        ctx.db
          .updateTable("core_pair_offers")
          .set({ device_id: deviceId })
          .where("id", "=", row.offer_id),
      );
    }
    const minted = await mintMobileToken(ctx, user.id, deviceId, row.device_name);
    ctx.change({
      entity: "desktop_device",
      id: deviceId,
      after: {
        user: user.id,
        name: row.device_name,
        platform: "android",
        keyStorage: row.key_storage,
        decides,
        offer: row.offer_id,
      },
    });
    return {
      ...minted,
      deviceId,
      login: user.github_login ?? null,
      keyStorage: row.key_storage,
      decides,
    };
  },
});

export const mobilePairOffer = defineOperation({
  name: "mobile.pairOffer",
  description:
    'Add a phone (ADR 0541 decision 6): a one-use pairing offer for your account, live 5 minutes, shown as a QR code and a typed code. Making it is the approval, so only a person makes it: on the website, or on the desktop with Touch ID ("Add a phone to your account"). Five wrong typed codes close it. Watch it with mobile.pairOfferStatus.',
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  presenceDecidable: true,
  // Offering from a device that already proves presence is the one exception ADR 0541 makes; a
  // phone can't offer a pairing.
  presenceSurfaces: ["desktop"],
  input: z.object({}),
  output: z.object({
    offerId: z.string(),
    /** What the QR code holds: the App Link with the secret in its fragment. */
    pairUrl: z.string(),
    /** Ten characters, shown as two groups of five. */
    code: z.string(),
    expiresAt: z.string(),
  }),
  redact: { output: (o) => ({ ...o, pairUrl: "[redacted]", code: "[redacted]" }) },
  async handler(_input, ctx) {
    const surface = ctx.origin.surface;
    if (surface !== "app" && surface !== "desktop" && surface !== "test") {
      throw new OperationError("forbidden", "add a phone from the website or the desktop app");
    }
    const live = await ctx.db
      .selectFrom("core_pair_offers")
      .select(["code_tag"])
      .where("expires_at", ">", ctx.now)
      .where("consumed_at", "is", null)
      .where("closed_at", "is", null)
      .execute();
    const mine = await ctx.db
      .selectFrom("core_pair_offers")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("user_id", "=", ctx.actor.id)
      .where("expires_at", ">", ctx.now)
      .where("consumed_at", "is", null)
      .where("closed_at", "is", null)
      .executeTakeFirst();
    if (Number(mine?.n ?? 0) >= PAIR_OFFER_LIMIT) {
      throw new OperationError(
        "unavailable",
        "too many open pairing codes: wait for them to expire",
      );
    }
    // A tag no live offer uses, so a wrong code counts against one offer only.
    const used = new Set(live.map((o) => o.code_tag));
    let code = randomCode(CODE_LENGTH);
    for (let i = 0; i < 20 && used.has(code.slice(0, TAG_LENGTH)); i++)
      code = randomCode(CODE_LENGTH);
    if (used.has(code.slice(0, TAG_LENGTH))) {
      throw new OperationError("unavailable", "too many pairings at once: try again in a minute");
    }
    const secret = randomToken();
    const id = newId("pairOffer");
    const expiresAt = new Date(Date.parse(ctx.now) + PAIR_OFFER_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_pair_offers").values({
        id,
        user_id: ctx.actor.id,
        surface: surface === "desktop" ? "desktop" : "app",
        secret_hash: await sha256Hex(secret),
        code_tag: code.slice(0, TAG_LENGTH),
        code_hash: await sha256Hex(code),
        created_at: ctx.now,
        expires_at: expiresAt,
        consumed_at: null,
        closed_at: null,
        device_id: null,
      }),
    );
    ctx.change({ entity: "pair_offer", id, after: { by: ctx.actor.id, surface } });
    return {
      offerId: id,
      pairUrl: `${baseUrl(ctx)}${MOBILE_PAIR_PATH}?offer=${id}#secret=${secret}`,
      code: formatPairCode(code),
      expiresAt,
    };
  },
});

export const mobilePairOfferStatus = defineOperation({
  name: "mobile.pairOfferStatus",
  description:
    "Where one of your pairing offers stands, for the screen that shows the code: waiting, paired (with the phone's name, where its key lives and its attested security level, so you can check it and remove it if it isn't yours), expired or closed.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ offerId }),
  output: z.object({
    status: z.enum(["waiting", "pairing", "paired", "expired", "closed"]),
    expiresAt: z.string(),
    device: z
      .object({
        id: z.string(),
        name: z.string(),
        keyStorage: z.string(),
        decides: z.boolean(),
        attestation: attestationSummary,
        revoked: z.boolean(),
      })
      .nullable(),
  }),
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_pair_offers")
      .selectAll()
      .where("id", "=", input.offerId)
      .executeTakeFirst();
    if (!row || row.user_id !== ctx.actor.id)
      throw new OperationError("not_found", "no such offer");
    const device = row.device_id
      ? await ctx.db
          .selectFrom("core_desktop_devices")
          .select(["id", "name", "key_storage", "decides", "attestation", "revoked_at"])
          .where("id", "=", row.device_id)
          .executeTakeFirst()
      : undefined;
    const status = device
      ? ("paired" as const)
      : row.consumed_at
        ? ("pairing" as const)
        : row.closed_at
          ? ("closed" as const)
          : expired(ctx, row)
            ? ("expired" as const)
            : ("waiting" as const);
    return {
      status,
      expiresAt: row.expires_at,
      device: device
        ? {
            id: device.id,
            name: device.name,
            keyStorage: device.key_storage,
            decides: device.decides === 1,
            attestation: parseAttestation(device.attestation),
            revoked: device.revoked_at !== null,
          }
        : null,
    };
  },
});

export const mobileRenew = defineOperation({
  name: "mobile.renew",
  description:
    "Renew this phone's sign-in for another 30 days (ADR 0541 decision 7): a new token for the same device, and its other tokens revoked. Only the phone itself, with a fingerprint for this exact call.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  presenceDecidable: true,
  presenceSurfaces: ["mobile"],
  input: z.object({}),
  output: z.object({ token: z.string(), tokenId: z.string(), expiresAt: z.string() }),
  redact: { output: (o) => ({ ...o, token: "[redacted]" }) },
  async handler(_input, ctx) {
    const deviceId = ctx.origin.deviceId;
    if (ctx.origin.surface !== "mobile" || !deviceId || !ctx.presence) {
      throw new OperationError("forbidden", "renew from the phone, with your fingerprint", {
        presenceRequired: true,
      });
    }
    const device = await ctx.db
      .selectFrom("core_desktop_devices")
      .select(["id", "user_id", "name", "revoked_at"])
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (!device || device.user_id !== ctx.actor.id || device.revoked_at) {
      throw new OperationError("forbidden", "this phone was removed: pair it again");
    }
    ctx.write(
      ctx.db
        .updateTable("core_cli_tokens")
        .set({ revoked_at: ctx.now })
        .where("device_id", "=", device.id)
        .where("kind", "=", "mobile")
        .where("revoked_at", "is", null),
    );
    const minted = await mintMobileToken(ctx, device.user_id, device.id, device.name);
    ctx.change({ entity: "desktop_device", id: device.id, after: { renewed: minted.tokenId } });
    return minted;
  },
});

/** The person, device and token behind a phone bearer token, or null if unknown, revoked or expired. */
export async function resolveMobileToken(
  db: HandlerContext["db"],
  token: string,
  now: string,
): Promise<{ id: string; user_id: string; device_id: string } | null> {
  if (!token.startsWith(MOBILE_TOKEN_PREFIX)) return null;
  const row = await db
    .selectFrom("core_cli_tokens as t")
    .innerJoin("core_desktop_devices as d", "d.id", "t.device_id")
    .select([
      "t.id as id",
      "t.user_id as user_id",
      "t.device_id as device_id",
      "t.expires_at as expires_at",
      "t.revoked_at as revoked_at",
      "d.revoked_at as device_revoked_at",
      "d.platform as platform",
    ])
    .where("t.token_hash", "=", await sha256Hex(token))
    .where("t.kind", "=", "mobile")
    .executeTakeFirst();
  if (!row?.device_id || row.revoked_at || row.device_revoked_at || row.platform !== "android") {
    return null;
  }
  if (Date.parse(row.expires_at) <= Date.parse(now)) return null;
  return { id: row.id, user_id: row.user_id, device_id: row.device_id };
}

export { MOBILE_PACKAGE };
