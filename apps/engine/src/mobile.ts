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
  MOBILE_DEVICE_ACTOR,
  MOBILE_PACKAGE,
  type MobileAttestationService,
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
  env: Pick<Env, "MOBILE_SIGNING_CERTS">,
): MobileAttestationService {
  const signingCerts = (env.MOBILE_SIGNING_CERTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    signingCerts,
    revoked: () => revokedSerials(),
    verify: (chain, expected) =>
      verifyAndroidAttestation(chain, {
        ...expected,
        packageName: MOBILE_PACKAGE,
        signingCerts,
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
