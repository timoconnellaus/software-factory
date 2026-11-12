// The phone app on sf-engine (ADR 0541, spec 60 PR 1a): what the client door needs for phones,
// kept out of cli.ts so the door changes by a few lines.
// - The unsigned sign-in routes `mobile/nonce`, `mobile/start` and `mobile/exchange`, as
//   MOBILE_DEVICE_ACTOR on the `mobile` surface.
// - The door protocol: the phone names it in `x-sf-client-protocol`. Below MOBILE_MIN_PROTOCOL
//   (no header is 0) a phone's request gets 426 `update_required`, and the app updates. There are
//   no phone builds from before the handshake, so the floor starts at 1.
// - The attestation service: `MOBILE_SIGNING_CERTS` and Google's revocation list, fetched from
//   https://android.googleapis.com/attestation/status and kept for a day. If it can't be fetched
//   and no copy younger than a day is held, phone sign-in is refused (fails closed).
// - The engine's HMAC for the phone: the stateless nonces and the caller hash are keyed under
//   RUNNER_CHANNEL_SECRET, separated by label (`sf-mobile:<label>:`), as runner keys are derived
//   under it (`sf-runner-channel:`). No secret, no phone sign-in.
import {
  GOOGLE_ATTESTATION_ROOTS,
  MAX_PATCH_AGE_MONTHS,
  MOBILE_DEVICE_ACTOR,
  MOBILE_PACKAGE,
  type MobileAttestationService,
  OperationError,
  PAIR_CODE_REFUSED,
  type PinnedRoot,
  verifyAndroidAttestation,
} from "@software-factory/core";
import { secrets } from "./secrets.ts";

/** The header a client names its door protocol in (ADR 0393's, shared with the desktop). */
export const MOBILE_PROTOCOL_HEADER = "x-sf-client-protocol";
/** The newest phone door protocol this engine speaks, and the oldest it still serves. */
export const MOBILE_PROTOCOL_LATEST = 1;
export const MOBILE_MIN_PROTOCOL = 1;

export const REVOCATION_URL = "https://android.googleapis.com/attestation/status";
const REVOCATION_TTL_MS = 24 * 3_600_000;

/**
 * Test seams only: tests trust a test root and supply the revocation list. Nothing in sf-engine's
 * own code sets them, so a deployed engine trusts Google's roots and Google's list alone.
 */
export const mobileTestSeams: {
  roots: readonly PinnedRoot[] | null;
  revoked: ReadonlySet<string> | null;
  fetch: typeof fetch | null;
  /** Runs between an operation's handler and its batch, to change the state under a call. */
  beforeCommit: ((operation: string) => Promise<void>) | null;
} = { roots: null, revoked: null, fetch: null, beforeCommit: null };

/** The phone's sign-in route for a door path, or null. */
export function mobileSignInRoute(
  path: string,
): "mobile.nonce" | "mobile.authStart" | "mobile.authExchange" | null {
  if (path === "mobile/nonce") return "mobile.nonce";
  if (path === "mobile/start") return "mobile.authStart";
  if (path === "mobile/exchange") return "mobile.authExchange";
  return null;
}

export { MOBILE_DEVICE_ACTOR };

const keys = new Map<string, Promise<CryptoKey>>();

/**
 * HMAC-SHA256 under the engine's secret, separated by label, base64url. Throws `unavailable` when
 * RUNNER_CHANNEL_SECRET isn't set.
 */
export async function mobileMac(env: Env, label: string, message: string): Promise<string> {
  const secret = secrets(env).RUNNER_CHANNEL_SECRET;
  if (!secret) {
    throw new OperationError("unavailable", "phone sign-in isn't set up on this engine");
  }
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keys.set(secret, key);
  }
  const mac = await crypto.subtle.sign(
    "HMAC",
    await key,
    new TextEncoder().encode(`sf-mobile:${label}:${message}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Who is calling the unsigned sign-in, for its per-caller limits: an HMAC under the engine's secret
 * of the address Cloudflare gives in `cf-connecting-ip` (which a client can't set through the
 * edge), an IPv6 address by its /64, since one connection usually holds a whole /64. Keyed, so the
 * stored value can't be reversed to an address by hashing the address space. Without the header (a
 * local engine) every call is the same caller.
 */
export async function mobileCaller(request: Request, env: Env): Promise<string> {
  const ip = (request.headers.get("cf-connecting-ip") ?? "").trim().toLowerCase();
  const key = ip.includes(":") ? `v6:${ipv6Prefix64(ip)}` : `v4:${ip}`;
  return (await mobileMac(env, "caller", key)).slice(0, 32);
}

/**
 * The per-caller courtesy limit on mobile/nonce (ADR 0541): ten a minute per caller key, from the
 * Workers rate limiting binding `MOBILE_NONCE_LIMIT`. The binding counts per Cloudflare location
 * and isn't exact, which is all a courtesy needs; it writes nothing to D1, so an attacker with many
 * addresses costs the factory no rows. Throws `unavailable` when the caller is over it.
 */
export async function mobileNonceLimit(env: Env, caller: string): Promise<void> {
  const { success } = await env.MOBILE_NONCE_LIMIT.limit({ key: caller });
  if (!success) {
    throw new OperationError(
      "unavailable",
      "too many sign-ins from this network: try again in a few minutes",
    );
  }
}

/** The first four groups of an IPv6 address, `::` expanded. */
export function ipv6Prefix64(ip: string): string {
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":");
}

/**
 * A guarded write in a phone sign-in found the state changed. For mobile/start: a typed code's
 * offer was used or closed while it was on its way, or a caller limit filled between the read and
 * the batch. The nonce is already spent (its own statement), and the answer is the one every
 * refused code gets, so it can't tell a right code from a wrong one.
 */
export function mobileSignInConflict(route: string, error: unknown): unknown {
  if (!(error instanceof OperationError) || error.code !== "conflict") return error;
  if (route === "mobile.authStart") {
    return new OperationError("forbidden", PAIR_CODE_REFUSED, {
      status: "refused",
      code: "forbidden",
      error: PAIR_CODE_REFUSED,
    });
  }
  return error;
}

/** The protocol a request says it speaks; no header (or garbage) is 0. */
export function sentProtocol(request: Request): number {
  const sent = request.headers.get(MOBILE_PROTOCOL_HEADER) ?? "";
  return /^\d{1,6}$/.test(sent) ? Number(sent) : 0;
}

/** 426 for a phone build older than the engine serves. */
export function mobileUpdateRequired(): Response {
  return Response.json(
    {
      error:
        "This version of the Software Factory phone app is too old for the factory: update it.",
      code: "update_required",
      minProtocol: MOBILE_MIN_PROTOCOL,
    },
    { status: 426, headers: { "cache-control": "no-store" } },
  );
}

let cached: { at: number; revoked: ReadonlySet<string> } | null = null;

/** Google's revocation list (serials as lowercase hex), from memory if younger than a day. */
export async function revokedSerials(now = Date.now()): Promise<ReadonlySet<string>> {
  if (mobileTestSeams.revoked) return mobileTestSeams.revoked;
  if (cached && now - cached.at < REVOCATION_TTL_MS) return cached.revoked;
  const res = await (mobileTestSeams.fetch ?? fetch)(REVOCATION_URL, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 3600 },
  } as RequestInit);
  if (!res.ok) throw new Error(`attestation status list: HTTP ${res.status}`);
  const body = (await res.json()) as { entries?: Record<string, unknown> };
  if (!body.entries || typeof body.entries !== "object") {
    throw new Error("attestation status list: no entries");
  }
  // Every entry is a reason to refuse (REVOKED or SUSPENDED): a listed certificate never passes.
  const revoked = new Set(Object.keys(body.entries).map((k) => k.toLowerCase().replace(/^0+/, "")));
  cached = { at: now, revoked };
  return revoked;
}

/** Forget the cached list (tests). */
export function clearRevocationCache() {
  cached = null;
}

/** The attestation service for invoke(), from the Worker's env. */
export function mobileAttestation(env: Env): MobileAttestationService {
  const signingCerts = (env.MOBILE_SIGNING_CERTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const months = Number.parseInt(env.MOBILE_MAX_PATCH_AGE_MONTHS ?? "", 10);
  const maxPatchAgeMonths = Number.isFinite(months) && months > 0 ? months : MAX_PATCH_AGE_MONTHS;
  return {
    signingCerts,
    revoked: () => revokedSerials(),
    mac: (label, message) => mobileMac(env, label, message),
    verify: (chain, expected) =>
      verifyAndroidAttestation(chain, {
        ...expected,
        packageName: MOBILE_PACKAGE,
        signingCerts,
        maxPatchAgeMonths,
        roots: mobileTestSeams.roots ?? GOOGLE_ATTESTATION_ROOTS,
      }),
  };
}

/**
 * Whether a phone's request speaks a protocol older than the engine serves: a phone sign-in route,
 * or any request with a phone token (`sfm_`, known by its prefix without a lookup).
 */
export function mobileTooOld(request: Request, path: string): boolean {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const phone = path.startsWith("mobile/") || bearer.startsWith("sfm_");
  return phone && sentProtocol(request) < MOBILE_MIN_PROTOCOL;
}
