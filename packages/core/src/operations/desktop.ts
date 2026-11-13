// The desktop app's devices and presence proofs (ADR 0391, spec 40 M1).
//
// Sign-in: the app makes a P-256 key in the Secure Enclave and calls desktop.authStart with its
// public half, a device name and a PKCE challenge, then opens /desktop/connect?request=… in the
// browser. The person approves there (desktop.approveDevice, browser-only), and the site sends the
// browser to sf://auth/callback?code=…&state=…. The app trades the code and its PKCE verifier for a
// desktop token bound to the device (desktop.authExchange). The token acts as the person on the
// `desktop` surface, like a `write` CLI token.
//
// Deciding a gate: the app asks for a one-time challenge for one operation and the digest of its
// input (presence.challenge), signs it with the device key, which makes macOS ask for Touch ID, and
// sends the signature with the call. The client door redeems it (presence.redeem) and only then
// marks the call's origin with the proof that invoke() checks.
//
// The app isn't anyone before it signs in, so sf-engine calls authStart and authExchange unsigned,
// as DESKTOP_DEVICE_ACTOR.
import type { KeyStorage } from "@software-factory/db";
import { z } from "zod";
import { type Actor, type DeviceSurface, isDeviceSurface } from "../actors.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { inputDigest, presenceSurfaceAllowed } from "../invoke.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { getOperation } from "../registry.ts";
import { describeConfigDecision } from "./config.ts";
import { deviceList, deviceRevoke } from "./device.ts";
import { randomToken, sha256Hex } from "./onboarding.ts";

/** The actor the client door uses for the two unsigned desktop sign-in calls. */
export const DESKTOP_DEVICE_ACTOR: Actor = { type: "runner", id: "desktop-device-login" };
/** Where a person approves a desktop sign-in on the website. */
export const DESKTOP_APPROVE_PATH = "/desktop/connect";
/** Where the website sends the browser back to the app. */
export const DESKTOP_CALLBACK_URL = "sf://auth/callback";
/** A sign-in request lives this long, from start to exchange. */
export const DESKTOP_AUTH_TTL_MS = 10 * 60_000;
/** A desktop token lasts this long; signing in again makes a new one. */
export const DESKTOP_TOKEN_TTL_MS = 30 * 24 * 3_600_000;
/** A presence challenge must be signed and used within this. */
export const PRESENCE_TTL_MS = 60_000;
/**
 * At most this many sign-ins wait for approval at once (desktop/start is unauthenticated). Real use
 * is one or two; past this, new ones are refused until old ones expire (10 minutes).
 */
export const DESKTOP_PENDING_LIMIT = 50;
/** Desktop tokens start with this, so they're recognisable in a leak scan. */
export const DESKTOP_TOKEN_PREFIX = "sfd_";

const b64url = /^[A-Za-z0-9_-]+$/;
export const publicKeyJwk = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(b64url).length(43),
  y: z.string().regex(b64url).length(43),
});
export type PublicKeyJwk = z.infer<typeof publicKeyJwk>;
export const deviceName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\w .@:'’()-]+$/, "letters, digits, spaces and . _ @ : ' ( ) - only");
const keyStorage = z.enum(["secure-enclave", "software"]);
const digestHex = z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 digest, as 64 hex characters");
const requestId = z.string().regex(/^dar_[0-9a-f]{32}$/);

export const expired = (ctx: HandlerContext, row: { expires_at: string }) =>
  Date.parse(row.expires_at) <= Date.parse(ctx.now);

function requireDeviceActor(ctx: HandlerContext) {
  if (ctx.actor.id !== DESKTOP_DEVICE_ACTOR.id) {
    throw new OperationError("forbidden", "only the desktop app's sign-in calls this");
  }
}

/** The signed-in device behind a desktop or phone call (ADR 0391, 0541). */
function requireDevice(ctx: HandlerContext): { deviceId: string; surface: DeviceSurface } {
  const deviceId = ctx.origin.deviceId;
  const surface = ctx.origin.surface;
  if (!isDeviceSurface(surface) || !deviceId) {
    throw new OperationError(
      "forbidden",
      "only a signed-in desktop or phone can do this (ADR 0391, 0541)",
    );
  }
  return { deviceId, surface };
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64Decode(text: string): Uint8Array {
  const std = text.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(hash));
}

export function importKey(jwk: PublicKeyJwk) {
  return crypto.subtle.importKey(
    "jwk",
    { ...jwk, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/** A short, human-checkable fingerprint of a device key (shown on the approval page). */
export async function keyFingerprint(jwk: PublicKeyJwk): Promise<string> {
  const hex = await sha256Hex(`${jwk.x}.${jwk.y}`);
  return hex.slice(0, 16).replace(/(.{4})(?!$)/g, "$1-");
}

/**
 * An ECDSA P-256 signature as WebCrypto wants it (r ‖ s, 64 bytes). Apple's Security framework
 * returns DER (X9.62); both are accepted.
 */
export function rawSignature(sig: Uint8Array): Uint8Array<ArrayBuffer> {
  if (sig.length === 64) return new Uint8Array(sig);
  // SEQUENCE { INTEGER r, INTEGER s }
  if (sig[0] !== 0x30) throw new Error("not a DER signature");
  let i = 2;
  const int = () => {
    if (sig[i] !== 0x02) throw new Error("not a DER integer");
    const len = sig[i + 1] ?? 0;
    let bytes = sig.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes.length > 32) throw new Error("integer too long");
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  const r = int();
  const s = int();
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}

/**
 * What a device signs for one challenge (ADR 0391). The last line is the summary the Touch ID
 * prompt shows; the key helper reads it from here, never from its caller.
 */
export const presenceMessage = (nonce: string, op: string, digest: string, summary: string) =>
  `${nonce}\n${op}\n${digest}\n${summary}`;

const quoted = (title: string) => `"${title.replace(/\s+/g, " ").slice(0, 80)}"`;

/**
 * The words for the decision a presence proof is for (ADR 0391), from the engine's own records,
 * never from the caller: the Touch ID prompt shows them.
 */
async function describeDecision(ctx: HandlerContext, op: string, input: Record<string, unknown>) {
  const item = async (id: unknown) =>
    typeof id === "string"
      ? await ctx.db
          .selectFrom("core_work_items as w")
          .leftJoin("core_repositories as r", "r.id", "w.repository_id")
          .select(["w.number", "w.title", "r.default_branch", "r.owner", "r.name"])
          .where("w.id", "=", id)
          .executeTakeFirst()
      : undefined;
  const named = async (id: unknown) => {
    const w = await item(id);
    return w ? `#${w.number} ${quoted(w.title)}` : "a work item";
  };
  switch (op) {
    case "spec.approve":
      return `Approve the spec for ${await named(input.workItemId)}`;
    case "spec.requestChanges":
      return `Request changes to the spec for ${await named(input.workItemId)}`;
    case "review.merge": {
      // The prompt names the commit, the repository and a merge without checks (spec 40 M4b,
      // spec 60): `Merge 3f2a91c "…" into main of acme/widgets, without its checks`. Every client
      // sends the head SHA; without one it falls back to the work item's number.
      const w = await item(input.workItemId);
      if (!w) return "Merge a work item";
      const commit =
        typeof input.headSha === "string" ? `${input.headSha.slice(0, 7)} ` : `#${w.number} `;
      const into = `${w.default_branch ?? "the default branch"}${w.owner ? ` of ${w.owner}/${w.name}` : ""}`;
      const without = input.mergeWithoutChecks === true ? ", without its checks" : "";
      return `Merge ${commit}${quoted(w.title)} into ${into}${without}`;
    }
    case "mobile.pairOffer":
      return "Add a phone to your account";
    case "mobile.renew":
      return "Renew this phone's sign-in for 30 days";
    case "device.update":
      return input.decides === true
        ? "Turn on fingerprint approvals on this device"
        : "Change this device's settings";
    case "review.sendBack":
      return `Send ${await named(input.workItemId)} back`;
    case "question.acceptDefaults":
      return `Accept the recommended answers on ${await named(input.workItemId)}`;
    case "question.answer": {
      const q =
        typeof input.questionId === "string"
          ? await ctx.db
              .selectFrom("core_questions")
              .select(["work_item_id"])
              .where("id", "=", input.questionId)
              .executeTakeFirst()
          : undefined;
      return `Answer a question on ${await named(q?.work_item_id)}`;
    }
    case "approval.decide": {
      const pa =
        typeof input.pendingActionId === "string"
          ? await ctx.db
              .selectFrom("core_pending_actions")
              .select(["operation", "work_item_id", "input", "project_id"])
              .where("id", "=", input.pendingActionId)
              .executeTakeFirst()
          : undefined;
      const verb = input.decision === "rejected" ? "Reject" : "Approve";
      // A config change names the project, the versions and what it loosens (ADR 0610).
      const config = pa ? await describeConfigDecision(ctx, pa, verb) : null;
      if (config) return config;
      return `${verb} ${pa ? `${pa.operation} on ${await named(pa.work_item_id)}` : "a pending action"}`;
    }
    default:
      return `Decide ${op}`;
  }
}

/** The person, device and token behind a desktop bearer token, or null if unknown, revoked or expired. */
export interface DesktopTokenRow {
  id: string;
  user_id: string;
  device_id: string;
}

/** Refuses a challenge on a device whose approvals are off, except to turn them back on. */
/**
 * Operations whose proof shows the person holds the device, not a decision (ADR 0541 amendment,
 * 2026-11-12): a phone with approvals off, or one registered as `software` (its boot isn't
 * verified), still renews its own token, or it would lapse after 30 days.
 */
export const POSSESSION_PROOFS = ["mobile.renew"] as const;
const possessionOnly = (op: string) => (POSSESSION_PROOFS as readonly string[]).includes(op);

async function requireDecides(ctx: HandlerContext, deviceId: string, op: string) {
  if (op === "device.update" || possessionOnly(op)) return;
  const d = await ctx.db
    .selectFrom("core_desktop_devices")
    .select(["decides"])
    .where("id", "=", deviceId)
    .executeTakeFirst();
  if (d && !d.decides) {
    throw new OperationError(
      "forbidden",
      "fingerprint approvals are off on this device: turn them on in You, or decide elsewhere",
      { approvalsOff: true },
    );
  }
}

export async function resolveDesktopToken(
  db: HandlerContext["db"],
  token: string,
  now: string,
): Promise<DesktopTokenRow | null> {
  if (!token.startsWith(DESKTOP_TOKEN_PREFIX)) return null;
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
    ])
    .where("t.token_hash", "=", await sha256Hex(token))
    .where("t.kind", "=", "desktop")
    .executeTakeFirst();
  if (!row?.device_id || row.revoked_at || row.device_revoked_at) return null;
  if (Date.parse(row.expires_at) <= Date.parse(now)) return null;
  return { id: row.id, user_id: row.user_id, device_id: row.device_id };
}

async function requestById(ctx: HandlerContext, id: string) {
  // A phone's sign-in (ADR 0541) is looked up and approved through mobile.*, not here.
  const row = await ctx.db
    .selectFrom("core_desktop_auth_requests")
    .selectAll()
    .where("id", "=", id)
    .where("platform", "=", "macos")
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "no such sign-in: start it again from the app");
  return row;
}

export const desktopAuthStart = defineOperation({
  name: "desktop.authStart",
  description:
    "Start a desktop app sign-in (ADR 0391): registers the device's P-256 public key (made in the Secure Enclave), its name and a PKCE S256 challenge, and returns the website page where a person approves it (10 minutes). Called unsigned by sf-engine's client door.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    deviceName,
    publicKey: publicKeyJwk,
    keyStorage: keyStorage.default("secure-enclave"),
    codeChallenge: z.string().regex(b64url).length(43),
    state: z.string().regex(b64url).min(16).max(200),
  }),
  output: z.object({ requestId: z.string(), approveUrl: z.string(), expiresAt: z.string() }),
  async handler(input, ctx) {
    requireDeviceActor(ctx);
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
    try {
      await importKey(input.publicKey);
    } catch {
      throw new OperationError("invalid_input", "publicKey is not a P-256 point");
    }
    const id = newId("desktopAuthRequest");
    const expiresAt = new Date(Date.parse(ctx.now) + DESKTOP_AUTH_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_desktop_auth_requests").values({
        id,
        code_challenge: input.codeChallenge,
        device_name: input.deviceName,
        public_key: JSON.stringify(input.publicKey),
        key_storage: input.keyStorage,
        state: input.state,
        user_id: null,
        code_hash: null,
        device_id: null,
        created_at: ctx.now,
        expires_at: expiresAt,
        decided_at: null,
        consumed_at: null,
      }),
    );
    const base = (ctx.services.publicBaseUrl ?? "").replace(/\/+$/, "");
    return { requestId: id, approveUrl: `${base}${DESKTOP_APPROVE_PATH}?request=${id}`, expiresAt };
  },
});

export const desktopAuthLookup = defineOperation({
  name: "desktop.authLookup",
  description:
    "What a desktop sign-in is waiting for, so the website can show it before a person approves: the device name, where its key lives, the key's fingerprint, its status and expiry.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ requestId }),
  output: z.object({
    requestId: z.string(),
    deviceName: z.string(),
    keyStorage,
    keyFingerprint: z.string(),
    status: z.enum(["pending", "approved", "denied", "consumed", "expired"]),
    expiresAt: z.string(),
  }),
  async handler(input, ctx) {
    const row = await requestById(ctx, input.requestId);
    return {
      requestId: row.id,
      deviceName: row.device_name,
      // A Mac's request is only ever secure-enclave or software (requestById reads macos only).
      keyStorage: row.key_storage === "secure-enclave" ? row.key_storage : ("software" as const),
      keyFingerprint: await keyFingerprint(JSON.parse(row.public_key) as PublicKeyJwk),
      status: row.status === "pending" && expired(ctx, row) ? ("expired" as const) : row.status,
      expiresAt: row.expires_at,
    };
  },
});

export const desktopApproveDevice = defineOperation({
  name: "desktop.approveDevice",
  description:
    "Approve a desktop app sign-in (ADR 0391): the device gets a token that acts as you in the app, and can decide gates only with Touch ID for each decision. Returns the sf:// link that hands the one-time code back to the app. Browser-only, for a pending, unexpired request.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  input: z.object({ requestId }),
  output: z.object({ approved: z.boolean(), redirectUrl: z.string() }),
  redact: { output: (o) => ({ ...o, redirectUrl: "[redacted]" }) },
  async handler(input, ctx) {
    const row = await requestById(ctx, input.requestId);
    if (row.status !== "pending") {
      throw new OperationError(
        "conflict",
        "this sign-in was already decided: start again from the app",
      );
    }
    if (expired(ctx, row)) {
      throw new OperationError("conflict", "this sign-in expired: start again from the app");
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
    return { approved: true, redirectUrl: `${DESKTOP_CALLBACK_URL}?${query}` };
  },
});

export const desktopDenyDevice = defineOperation({
  name: "desktop.denyDevice",
  description: "Deny a desktop app sign-in you didn't start: it can't be exchanged for a token.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ requestId }),
  output: z.object({ denied: z.boolean() }),
  async handler(input, ctx) {
    const row = await requestById(ctx, input.requestId);
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

export const desktopAuthExchange = defineOperation({
  name: "desktop.authExchange",
  description:
    "The desktop app trades the one-time code from the sf:// callback, with its PKCE verifier, for a desktop token (30 days) bound to the device it registered. Once only. Called unsigned by sf-engine's client door.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    code: z.string().min(20).max(200),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  output: z.object({
    token: z.string(),
    tokenId: z.string(),
    deviceId: z.string(),
    expiresAt: z.string(),
    login: z.string().nullable(),
  }),
  redact: {
    input: () => ({ code: "[redacted]", codeVerifier: "[redacted]" }),
    output: (o) => ({ ...o, token: "[redacted]" }),
  },
  async handler(input, ctx) {
    requireDeviceActor(ctx);
    const refused = () =>
      new OperationError("denied", "this sign-in can't be completed: start again from the app");
    const row = await ctx.db
      .selectFrom("core_desktop_auth_requests")
      .selectAll()
      .where("code_hash", "=", await sha256Hex(input.code))
      .where("platform", "=", "macos")
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
    const token = `${DESKTOP_TOKEN_PREFIX}${randomToken(32)}`;
    const tokenId = newId("cliToken");
    const expiresAt = new Date(Date.parse(ctx.now) + DESKTOP_TOKEN_TTL_MS).toISOString();
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
        key_storage: row.key_storage as KeyStorage,
        created_at: ctx.now,
        last_seen_at: null,
        revoked_at: null,
      }),
    );
    ctx.write(
      ctx.db.insertInto("core_cli_tokens").values({
        id: tokenId,
        token_hash: await sha256Hex(token),
        user_id: user.id,
        name: row.device_name,
        scope: "write",
        kind: "desktop",
        device_id: deviceId,
        created_at: ctx.now,
        expires_at: expiresAt,
        revoked_at: null,
      }),
    );
    ctx.change({
      entity: "desktop_device",
      id: deviceId,
      after: { user: user.id, name: row.device_name, keyStorage: row.key_storage },
    });
    return { token, tokenId, deviceId, expiresAt, login: user.github_login ?? null };
  },
});

/** device.list under its first name (ADR 0541): the desktop app calls it. */
export const desktopDeviceList = {
  ...deviceList,
  name: "desktopDevice.list",
  description: `The same as device.list (its first name). ${deviceList.description}`,
};

/** device.revoke under its first name (ADR 0541). */
export const desktopDeviceRevoke = {
  ...deviceRevoke,
  name: "desktopDevice.revoke",
  description: `The same as device.revoke (its first name). ${deviceRevoke.description}`,
};

export const presenceChallenge = defineOperation({
  name: "presence.challenge",
  description:
    "A one-time challenge (60 s) for deciding one gate from the desktop app or the phone (ADR 0391, 0541): bound to the operation and the SHA-256 of its canonical input, with a summary of the decision written from the factory's own records (the Touch ID or fingerprint prompt shows it). The device signs nonce, op, digest and summary with its hardware key. Desktop and phone devices only, for operations presence-decidable on that surface; refused for a device whose approvals are off.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({
    op: z.string().min(1).max(80),
    /** The decision's own input, exactly as it will be sent. */
    input: z.record(z.string(), z.unknown()),
  }),
  output: z.object({
    challengeId: z.string(),
    nonce: z.string(),
    inputDigest: z.string(),
    summary: z.string(),
    expiresAt: z.string(),
  }),
  redact: {
    input: (i) => ({ op: i.op, input: "[digested]" }),
    output: (o) => ({ ...o, nonce: "[redacted]" }),
  },
  async handler(input, ctx) {
    const { deviceId, surface } = requireDevice(ctx);
    const target = getOperation(input.op);
    if (!target || !presenceSurfaceAllowed(target, surface, input.input)) {
      throw new OperationError(
        "forbidden",
        `${input.op} can't be decided with a presence proof from the ${surface}: it stays in the browser (ADR 0391, 0541)`,
      );
    }
    await requireDecides(ctx, deviceId, input.op);
    const digest = await inputDigest(input.input);
    const summary = await describeDecision(ctx, input.op, input.input);
    const nonce = randomToken();
    const challengeId = newId("presenceChallenge");
    const expiresAt = new Date(Date.parse(ctx.now) + PRESENCE_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_presence_challenges").values({
        id: challengeId,
        device_id: deviceId,
        op: input.op,
        input_digest: digest,
        summary,
        nonce_hash: await sha256Hex(nonce),
        created_at: ctx.now,
        expires_at: expiresAt,
        consumed_at: null,
      }),
    );
    return { challengeId, nonce, inputDigest: digest, summary, expiresAt };
  },
});

export const presenceRedeem = defineOperation({
  name: "presence.redeem",
  description:
    "The client door spends a signed presence challenge before running the decision it is for (ADR 0391, 0541). Checks the challenge belongs to this device, is unused and unexpired, names this operation and input digest, that the device key is in hardware (the Secure Enclave, StrongBox or the TEE) and its approvals are on, and that the signature (ECDSA P-256 over nonce, op, digest and summary) verifies with the device key. Desktop and phone devices only.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({
    challengeId: z.string().regex(/^prc_[0-9a-f]{32}$/),
    nonce: z.string().min(20).max(200),
    signature: z.string().min(40).max(200),
    op: z.string().min(1).max(80),
    inputDigest: digestHex,
  }),
  output: z.object({ redeemed: z.boolean() }),
  redact: { input: (i) => ({ ...i, nonce: "[redacted]", signature: "[redacted]" }) },
  async handler(input, ctx) {
    const { deviceId, surface } = requireDevice(ctx);
    const refused = (why: string) =>
      new OperationError("forbidden", `presence proof refused: ${why}`, { browserOnly: true });
    const challenge = await ctx.db
      .selectFrom("core_presence_challenges")
      .selectAll()
      .where("id", "=", input.challengeId)
      .executeTakeFirst();
    if (!challenge || challenge.device_id !== deviceId) throw refused("unknown challenge");
    if (challenge.consumed_at) throw refused("already used");
    if (expired(ctx, challenge)) throw refused("expired");
    if (challenge.op !== input.op || challenge.input_digest !== input.inputDigest) {
      throw refused("it was made for another decision");
    }
    if ((await sha256Hex(input.nonce)) !== challenge.nonce_hash) throw refused("wrong nonce");
    const device = await ctx.db
      .selectFrom("core_desktop_devices")
      .select(["public_key", "revoked_at", "key_storage", "platform", "decides"])
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (!device || device.revoked_at) throw refused("device revoked");
    if ((device.platform === "android") !== (surface === "mobile")) {
      throw refused(`this device isn't a ${surface === "mobile" ? "phone" : "Mac"}`);
    }
    // A software key can be read by any process of the user: it proves nothing (ADR 0391). A phone
    // whose boot isn't verified or whose bootloader is unlocked is stored as `software` too (0541).
    // DESKTOP_ALLOW_SOFTWARE_KEYS is for a Mac's unsigned dev build only: a phone never decides
    // with a software key, whatever the engine's settings. Renewing a phone's own token isn't a
    // decision: its Keystore key (attested at sign-in) signs it, whatever the boot state.
    const hardware =
      device.platform === "android"
        ? device.key_storage === "strongbox" || device.key_storage === "tee"
        : device.key_storage === "secure-enclave";
    const renewal = device.platform === "android" && possessionOnly(input.op);
    const devSoftwareMac = device.platform === "macos" && ctx.services.allowSoftwareDeviceKeys;
    if (!hardware && !renewal && !devSoftwareMac) {
      throw refused(
        device.platform === "android"
          ? "this phone can't approve: its key isn't attested in secure hardware on a verified, locked phone"
          : "this device's key isn't in the Secure Enclave (an unsigned build): decide on the website",
      );
    }
    if (!device.decides && input.op !== "device.update" && !possessionOnly(input.op)) {
      throw refused("approvals are off on this device");
    }
    let valid = false;
    try {
      const key = await importKey(JSON.parse(device.public_key) as PublicKeyJwk);
      valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        rawSignature(base64Decode(input.signature)),
        new TextEncoder().encode(
          presenceMessage(input.nonce, input.op, input.inputDigest, challenge.summary),
        ),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw refused("bad signature");
    ctx.write(
      ctx.db
        .updateTable("core_presence_challenges")
        .set({ consumed_at: ctx.now })
        .where("id", "=", challenge.id)
        .where("consumed_at", "is", null),
    );
    ctx.guardChanged("use a presence proof once");
    ctx.write(
      ctx.db
        .updateTable("core_desktop_devices")
        .set({ last_seen_at: ctx.now })
        .where("id", "=", deviceId),
    );
    return { redeemed: true };
  },
});
