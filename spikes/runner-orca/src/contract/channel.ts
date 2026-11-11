// The signed runner channel (ADR 0100; the same construction as Relationship OS ADR 0250). The
// runner host only connects outbound: every call is an HTTPS request from the host to the cloud,
// and cloud → runner commands (cancel, steer) ride back on the heartbeat response.
//
// Each runner has its own key, derived from one cloud master secret, so nothing per runner is
// stored in the cloud and one runner's key can't sign for another:
//
//   runnerKey = base64url(HMAC-SHA256(RUNNER_CHANNEL_SECRET, "sf-runner-channel:" + runnerId))
//
// A request carries
//
//   x-sf-runner           the runner id
//   x-sf-timestamp        unix seconds; refused when more than 5 minutes off
//   x-sf-idempotency-key  unique per logical call; a retry reuses it
//   x-sf-signature        v1=<hex HMAC-SHA256(runnerKey,
//                           "v1\n<runner>\n<timestamp>\n<METHOD>\n<path>\n<sha256 hex of body>\n<idempotency key>")>
//
// No nonce is stored for replay protection: a captured request replays only within its 5 minutes,
// for the same runner, path, body and idempotency key, and the cloud answers a repeated key with
// the stored response instead of acting twice. So a replay, or a host retry after a lost
// response, changes nothing.
//
// Web Crypto only, so it runs in Workers and in Node.

export const CHANNEL_MAX_SKEW_SECONDS = 300;
export const HEADER_RUNNER = "x-sf-runner";
export const HEADER_TIMESTAMP = "x-sf-timestamp";
export const HEADER_IDEMPOTENCY = "x-sf-idempotency-key";
export const HEADER_SIGNATURE = "x-sf-signature";

const RUNNER_ID = /^r_[a-z0-9]{6,32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(message));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** A runner's channel key, derived from the cloud's master secret. */
export async function runnerChannelKey(masterSecret: string, runnerId: string): Promise<string> {
  if (!masterSecret) throw new Error("the runner channel needs RUNNER_CHANNEL_SECRET");
  if (!RUNNER_ID.test(runnerId)) throw new Error(`bad runner id: ${runnerId}`);
  return base64url(await hmac(masterSecret, `sf-runner-channel:${runnerId}`));
}

interface SignedParts {
  runner: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
  idempotencyKey: string;
}

async function signature(key: string, parts: SignedParts): Promise<string> {
  const message = [
    "v1",
    parts.runner,
    parts.timestamp,
    parts.method.toUpperCase(),
    parts.path,
    await sha256Hex(parts.body),
    parts.idempotencyKey,
  ].join("\n");
  return `v1=${hex(await hmac(key, message))}`;
}

/** The headers for one signed request from a runner host. */
export async function signRunnerRequest(input: {
  key: string;
  runner: string;
  method: string;
  path: string;
  body: string;
  idempotencyKey: string;
  now?: Date;
}): Promise<Record<string, string>> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new Error("bad idempotency key");
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1000));
  return {
    [HEADER_RUNNER]: input.runner,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_IDEMPOTENCY]: input.idempotencyKey,
    [HEADER_SIGNATURE]: await signature(input.key, { ...input, timestamp }),
  };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type VerifiedRequest = {
  ok: true;
  runner: string;
  idempotencyKey: string;
  body: string;
};
export type RefusedRequest = { ok: false; status: 401; reason: string };

/** Verifies a signed request. `keyFor` returns the runner's key, or null for an unknown runner. */
export async function verifyRunnerRequest(
  request: Request,
  keyFor: (runner: string) => Promise<string | null>,
  options: { now?: Date } = {},
): Promise<VerifiedRequest | RefusedRequest> {
  const runner = request.headers.get(HEADER_RUNNER) ?? "";
  const timestamp = request.headers.get(HEADER_TIMESTAMP) ?? "";
  const idempotencyKey = request.headers.get(HEADER_IDEMPOTENCY) ?? "";
  const given = request.headers.get(HEADER_SIGNATURE) ?? "";
  if (
    !RUNNER_ID.test(runner) ||
    !/^\d{1,12}$/.test(timestamp) ||
    !IDEMPOTENCY_KEY.test(idempotencyKey) ||
    !given.startsWith("v1=")
  ) {
    return { ok: false, status: 401, reason: "unsigned request" };
  }
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > CHANNEL_MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, reason: "stale request" };
  }
  const key = await keyFor(runner);
  if (!key) return { ok: false, status: 401, reason: "unknown runner" };
  const body = await request.text();
  const expected = await signature(key, {
    runner,
    timestamp,
    method: request.method,
    path: new URL(request.url).pathname,
    body,
    idempotencyKey,
  });
  if (!safeEqual(expected, given)) return { ok: false, status: 401, reason: "bad signature" };
  return { ok: true, runner, idempotencyKey, body };
}

/**
 * Where the cloud remembers answered calls. Keyed by (runner, idempotency key); kept for at least
 * the skew window plus the host's retry horizon (D1 or a Durable Object in the real engine).
 */
export interface IdempotencyStore {
  get(runner: string, key: string): Promise<{ bodyHash: string; response: string } | null>;
  put(runner: string, key: string, value: { bodyHash: string; response: string }): Promise<void>;
}

export function memoryIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, { bodyHash: string; response: string }>();
  return {
    get: async (runner, key) => rows.get(`${runner}\n${key}`) ?? null,
    put: async (runner, key, value) => {
      rows.set(`${runner}\n${key}`, value);
    },
  };
}

/**
 * The cloud side of one channel call: verify, then answer a repeated idempotency key with the
 * stored response (or 409 if the same key arrives with a different body), else run the handler
 * once and store its answer.
 */
export async function handleRunnerCall(
  request: Request,
  deps: {
    keyFor: (runner: string) => Promise<string | null>;
    store: IdempotencyStore;
    now?: Date;
  },
  handler: (call: { runner: string; path: string; body: unknown }) => Promise<unknown>,
): Promise<Response> {
  const verified = await verifyRunnerRequest(
    request,
    deps.keyFor,
    deps.now ? { now: deps.now } : {},
  );
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: verified.status });
  const bodyHash = await sha256Hex(verified.body);
  const seen = await deps.store.get(verified.runner, verified.idempotencyKey);
  if (seen) {
    if (seen.bodyHash !== bodyHash) {
      return Response.json({ error: "idempotency key reused with another body" }, { status: 409 });
    }
    return new Response(seen.response, {
      headers: { "content-type": "application/json", "x-sf-replayed": "1" },
    });
  }
  let body: unknown;
  try {
    body = verified.body ? JSON.parse(verified.body) : null;
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  const result = await handler({
    runner: verified.runner,
    path: new URL(request.url).pathname,
    body,
  });
  const response = JSON.stringify(result ?? null);
  await deps.store.put(verified.runner, verified.idempotencyKey, { bodyHash, response });
  return new Response(response, { headers: { "content-type": "application/json" } });
}
