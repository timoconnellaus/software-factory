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
import {
  GOOGLE_ATTESTATION_ROOTS,
  MAX_PATCH_AGE_MONTHS,
  MOBILE_DEVICE_ACTOR,
  MOBILE_PACKAGE,
  type MobileAttestationService,
  OperationError,
  type PinnedRoot,
  verifyAndroidAttestation,
} from "@software-factory/core";

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
} = { roots: null, revoked: null, fetch: null };

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

/**
 * Who is calling the unsigned sign-in, for its per-caller limits: a hash of the address Cloudflare
 * gives in `cf-connecting-ip` (which a client can't set through the edge), an IPv6 address by its
 * /64, since one connection usually holds a whole /64. Without the header (a local engine) every
 * call is the same caller.
 */
export async function mobileCaller(request: Request): Promise<string> {
  const ip = (request.headers.get("cf-connecting-ip") ?? "").trim().toLowerCase();
  const key = ip.includes(":") ? `v6:${ipv6Prefix64(ip)}` : `v4:${ip}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
 * A guarded write in a phone sign-in found the state changed: the nonce was spent by a parallel
 * call, a limit filled up between the read and the batch, or the offer closed or was used while the
 * code was on its way. Said plainly instead of "the state changed".
 */
export function mobileSignInConflict(route: string, error: unknown): unknown {
  if (!(error instanceof OperationError) || error.code !== "conflict") return error;
  if (route === "mobile.nonce") {
    return new OperationError(
      "unavailable",
      "too many sign-ins at once: try again in a few minutes",
    );
  }
  if (route === "mobile.authStart") {
    return new OperationError(
      "conflict",
      "this sign-in changed while it was sent (its nonce was used, or the code's offer was used or closed): start again, and if the code is refused, make a new code on the desktop or the website",
    );
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
export function mobileAttestation(
  env: Pick<Env, "MOBILE_SIGNING_CERTS" | "MOBILE_MAX_PATCH_AGE_MONTHS">,
): MobileAttestationService {
  const signingCerts = (env.MOBILE_SIGNING_CERTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const months = Number.parseInt(env.MOBILE_MAX_PATCH_AGE_MONTHS ?? "", 10);
  const maxPatchAgeMonths = Number.isFinite(months) && months > 0 ? months : MAX_PATCH_AGE_MONTHS;
  return {
    signingCerts,
    revoked: () => revokedSerials(),
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
