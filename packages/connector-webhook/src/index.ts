// The inbound webhook connector (ADR 0010): the provider-neutral half. It reads a delivery's raw
// body, checks its HMAC signature against the shared secret in constant time, and names the
// delivery so the caller can dedupe it (`connector.receive` records it after it's handled).
// Nothing here writes; the provider half (`@software-factory/connector-github`) maps events to
// operations.

export const PACKAGE = "@software-factory/connector-webhook";

/** Deliveries larger than this are refused before any parsing (GitHub caps payloads at 25 MB). */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface SignatureScheme {
  /** The header carrying the signature, e.g. `x-hub-signature-256`. */
  header: string;
  /** Text before the hex digest, e.g. `sha256=`. */
  prefix: string;
  /** The header naming the delivery, for dedupe, e.g. `x-github-delivery`. */
  deliveryHeader: string;
  /** The header naming the event type, e.g. `x-github-event`. */
  eventHeader: string;
}

export const GITHUB_SIGNATURE: SignatureScheme = {
  header: "x-hub-signature-256",
  prefix: "sha256=",
  deliveryHeader: "x-github-delivery",
  eventHeader: "x-github-event",
};

export type Delivery =
  | { ok: true; deliveryId: string; event: string; body: string }
  | { ok: false; status: 400 | 401 | 405 | 413 | 503; error: string };

/**
 * Reads and authenticates one webhook delivery. An unset secret refuses everything (503): an
 * unauthenticated webhook is never accepted.
 */
export async function readDelivery(
  request: Request,
  secret: string | undefined,
  scheme: SignatureScheme = GITHUB_SIGNATURE,
): Promise<Delivery> {
  if (request.method !== "POST") return { ok: false, status: 405, error: "POST only" };
  if (!secret) return { ok: false, status: 503, error: "the webhook secret is not set" };
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return { ok: false, status: 413, error: "payload too large" };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES)
    return { ok: false, status: 413, error: "payload too large" };
  const signature = request.headers.get(scheme.header);
  if (!signature) return { ok: false, status: 401, error: `missing ${scheme.header}` };
  if (!(await verifySignature(secret, bytes, signature, scheme.prefix))) {
    return { ok: false, status: 401, error: "bad signature" };
  }
  const deliveryId = request.headers.get(scheme.deliveryHeader);
  const event = request.headers.get(scheme.eventHeader);
  if (!deliveryId || !event) {
    return {
      ok: false,
      status: 400,
      error: `missing ${scheme.deliveryHeader} or ${scheme.eventHeader}`,
    };
  }
  return { ok: true, deliveryId, event, body: new TextDecoder().decode(bytes) };
}

/** HMAC-SHA256 of the raw body under `secret`, compared with `<prefix><hex>` in constant time. */
export async function verifySignature(
  secret: string,
  body: Uint8Array | string,
  header: string,
  prefix = "sha256=",
): Promise<boolean> {
  if (!header.startsWith(prefix)) return false;
  const given = hexToBytes(header.slice(prefix.length));
  if (given?.byteLength !== 32) return false;
  const expected = new Uint8Array(await hmac(secret, body));
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (expected[i] ?? 0) ^ (given[i] ?? 0);
  return diff === 0;
}

/** `<prefix><hex HMAC-SHA256>`: what a provider sends, for tests and local replays. */
export async function sign(
  secret: string,
  body: Uint8Array | string,
  prefix = "sha256=",
): Promise<string> {
  const mac = new Uint8Array(await hmac(secret, body));
  return prefix + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, body: Uint8Array | string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
