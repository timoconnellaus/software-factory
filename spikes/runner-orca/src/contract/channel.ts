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

/**
 * A runner's channel key, derived from the cloud's master secret. `version` is stored per runner
 * (it starts at 1): bumping it revokes that one runner's key without touching the others.
 */
export async function runnerChannelKey(
  masterSecret: string,
  runnerId: string,
  version = 1,
): Promise<string> {
  if (!masterSecret) throw new Error("the runner channel needs RUNNER_CHANNEL_SECRET");
  if (!RUNNER_ID.test(runnerId)) throw new Error(`bad runner id: ${runnerId}`);
  return base64url(await hmac(masterSecret, `sf-runner-channel:${runnerId}:v${version}`));
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
  /** The runner's key, for signing the response. */
  key: string;
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
  return { ok: true, runner, key, idempotencyKey, body };
}

// Responses are signed too (ADR 0016: "every call in either direction"), so a TLS-terminating
// proxy can't hand the host a job or a command the cloud never sent. The response signature binds
// the status and body to the request's path and idempotency key:
//   x-sf-signature  v1=<hex HMAC(runnerKey, "v1-response\n<runner>\n<timestamp>\n<status>\n<path>\n<sha256 hex of body>\n<idempotency key>")>

interface ResponseParts {
  runner: string;
  timestamp: string;
  status: number;
  path: string;
  body: string;
  idempotencyKey: string;
}

async function responseSignature(key: string, parts: ResponseParts): Promise<string> {
  const message = [
    "v1-response",
    parts.runner,
    parts.timestamp,
    String(parts.status),
    parts.path,
    await sha256Hex(parts.body),
    parts.idempotencyKey,
  ].join("\n");
  return `v1=${hex(await hmac(key, message))}`;
}

/** A signed JSON response from the cloud to one runner call. */
export async function signedRunnerResponse(input: {
  key: string;
  runner: string;
  path: string;
  idempotencyKey: string;
  status?: number;
  body: string;
  replayed?: boolean;
  now?: Date;
}): Promise<Response> {
  const status = input.status ?? 200;
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1000));
  return new Response(input.body, {
    status,
    headers: {
      "content-type": "application/json",
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_SIGNATURE]: await responseSignature(input.key, { ...input, status, timestamp }),
      ...(input.replayed ? { "x-sf-replayed": "1" } : {}),
    },
  });
}

/** Checks a response came from the cloud for this exact call. Returns its body text. */
export async function verifyRunnerResponse(
  response: Response,
  expected: { key: string; runner: string; path: string; idempotencyKey: string; now?: Date },
): Promise<{ ok: true; body: string } | { ok: false; reason: string }> {
  const timestamp = response.headers.get(HEADER_TIMESTAMP) ?? "";
  const given = response.headers.get(HEADER_SIGNATURE) ?? "";
  if (!/^\d{1,12}$/.test(timestamp) || !given.startsWith("v1=")) {
    return { ok: false, reason: "unsigned response" };
  }
  const now = Math.floor((expected.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > CHANNEL_MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale response" };
  }
  const body = await response.text();
  const want = await responseSignature(expected.key, {
    ...expected,
    timestamp,
    status: response.status,
    body,
  });
  if (!safeEqual(want, given)) return { ok: false, reason: "bad response signature" };
  return { ok: true, body };
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
  // Refusals go out unsigned: there may be no key to sign with, and the host treats any
  // non-2xx as a failure anyway.
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: verified.status });
  const path = new URL(request.url).pathname;
  const reply = (body: string, status = 200, replayed = false) =>
    signedRunnerResponse({
      key: verified.key,
      runner: verified.runner,
      path,
      idempotencyKey: verified.idempotencyKey,
      status,
      body,
      replayed,
      ...(deps.now ? { now: deps.now } : {}),
    });
  const bodyHash = await sha256Hex(verified.body);
  const seen = await deps.store.get(verified.runner, verified.idempotencyKey);
  if (seen) {
    if (seen.bodyHash !== bodyHash) {
      return reply(JSON.stringify({ error: "idempotency key reused with another body" }), 409);
    }
    return reply(seen.response, 200, true);
  }
  let body: unknown;
  try {
    body = verified.body ? JSON.parse(verified.body) : null;
  } catch {
    return reply(JSON.stringify({ error: "body is not JSON" }), 400);
  }
  const result = await handler({ runner: verified.runner, path, body });
  const response = JSON.stringify(result ?? null);
  await deps.store.put(verified.runner, verified.idempotencyKey, { bodyHash, response });
  return reply(response);
}
