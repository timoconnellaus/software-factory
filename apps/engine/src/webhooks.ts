// The GitHub App's webhook (ADR 0010, 0025, 0055): POST /webhooks/github, served on
// software-factory.zerobsai.com by a Workers route in front of sf-app (and on sf-engine's own
// domain). The delivery is authenticated (HMAC-SHA256 of the raw body under the webhook secret,
// compared in constant time), then the App's installation events keep the org's installation record
// current through `github.installation`, as the `github` intake. Every other event is acknowledged
// and ignored: the new core reads pull requests and checks through the `github` gateway when a
// plugin asks (spec 70). A redelivery is harmless: the call's idempotency key is the delivery id.
import { invoke, isOperationError } from "@software-factory/core";
import { z } from "zod";
import { invokeDeps } from "./deps.ts";
import { secrets } from "./secrets.ts";

export const WEBHOOK_PATH = "/webhooks/github";
/** Deliveries larger than this are refused before any parsing (GitHub caps payloads at 25 MB). */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

const GITHUB_INTAKE = { type: "intake", id: "github" } as const;

const installationPayload = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string() }),
    repository_selection: z.enum(["all", "selected"]).optional(),
  }),
  repository_selection: z.enum(["all", "selected"]).optional(),
});

/**
 * What `github.installation` should record for one delivery, or null for anything else. An
 * `installation` event's action, or for `installation_repositories` (repositories added or removed,
 * or the selection changed) `added`, which refreshes the record's selection.
 */
export function installationCall(
  event: string,
  payload: unknown,
): {
  action: string;
  installationId: string;
  account: string;
  repositorySelection?: string;
} | null {
  if (event !== "installation" && event !== "installation_repositories") return null;
  const p = installationPayload.safeParse(payload);
  if (!p.success) return null;
  const d = p.data;
  const action =
    event === "installation_repositories"
      ? "added"
      : (
          {
            created: "added",
            new_permissions_accepted: "added",
            suspend: "suspended",
            unsuspend: "unsuspended",
            deleted: "deleted",
          } as Record<string, string>
        )[d.action];
  if (!action) return null;
  const selection = d.repository_selection ?? d.installation.repository_selection;
  return {
    action,
    installationId: String(d.installation.id),
    account: d.installation.account.login,
    ...(selection ? { repositorySelection: selection } : {}),
  };
}

export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const delivery = await readDelivery(request, secrets(env).GH_APP_WEBHOOK_SECRET);
  if (!delivery.ok) return Response.json({ error: delivery.error }, { status: delivery.status });
  let payload: unknown;
  try {
    payload = JSON.parse(delivery.body);
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }
  const call = installationCall(delivery.event, payload);
  if (!call) return Response.json({ ok: true, event: delivery.event, ignored: true });
  try {
    const r = await invoke(invokeDeps(env), "github.installation", call, {
      actor: GITHUB_INTAKE,
      origin: { surface: "connector", requestId: delivery.deliveryId },
      idempotencyKey: `github:${delivery.deliveryId}`,
    });
    return Response.json({ ok: true, event: delivery.event, result: r.output });
  } catch (error) {
    // A refusal is audited by invoke() and reported; it doesn't make GitHub redeliver. Anything
    // else is a 500, which GitHub shows as failed (redeliver by hand).
    if (!isOperationError(error)) throw error;
    return Response.json({ ok: true, event: delivery.event, refused: error.code });
  }
}

type Delivery =
  | { ok: true; deliveryId: string; event: string; body: string }
  | { ok: false; status: 400 | 401 | 405 | 413 | 503; error: string };

/**
 * Reads and authenticates one delivery. An unset secret refuses everything (503): an
 * unauthenticated webhook is never accepted.
 */
async function readDelivery(request: Request, secret: string | undefined): Promise<Delivery> {
  if (request.method !== "POST") return { ok: false, status: 405, error: "POST only" };
  if (!secret) return { ok: false, status: 503, error: "the webhook secret is not set" };
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return { ok: false, status: 413, error: "payload too large" };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "payload too large" };
  }
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature) return { ok: false, status: 401, error: "missing x-hub-signature-256" };
  if (!(await verifySignature(secret, bytes, signature))) {
    return { ok: false, status: 401, error: "bad signature" };
  }
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (!deliveryId || !event) {
    return { ok: false, status: 400, error: "missing x-github-delivery or x-github-event" };
  }
  return { ok: true, deliveryId, event, body: new TextDecoder().decode(bytes) };
}

/** HMAC-SHA256 of the raw body under `secret`, compared with `sha256=<hex>` in constant time. */
export async function verifySignature(
  secret: string,
  body: Uint8Array | string,
  header: string,
): Promise<boolean> {
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  const hex = header.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const given = new Uint8Array(32);
  for (let i = 0; i < 32; i++) given[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>),
  );
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (expected[i] ?? 0) ^ (given[i] ?? 0);
  return diff === 0;
}
