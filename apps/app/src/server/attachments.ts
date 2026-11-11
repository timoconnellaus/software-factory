// Uploading and serving work item attachments (ADR 0260). Both go through operations on sf-engine
// as the signed-in person: the upload calls `workItem.attachment.add` (authz, limits, sniffing and
// the audit row all live there), serving calls `workItem.attachment.get` and answers with headers
// chosen here, never by the browser's guess. Neither is a public or long-lived URL: each request
// carries the session cookie, and anyone without access gets the same 404 as for a missing file.
import { ATTACHMENT_LIMITS, attachmentResponseHeaders } from "@software-factory/core/attachments";
import type { AppEnv } from "./app-api.ts";
import { userFromRequest } from "./auth.ts";

/** `POST /api/work/<work item id>/attachments`: the body is the file. */
export const UPLOAD_PATH = /^\/api\/work\/(wi_[0-9a-f]{32})\/attachments$/;
/** `GET /api/attachments/<attachment id>`: the file, with safe headers. */
export const SERVE_PATH = /^\/api\/attachments\/(att_[0-9a-f]{32})$/;
/** The header an upload must carry: a cross-site form can't set it without a CORS preflight. */
export const UPLOAD_HEADER = "x-sf-upload";

export type UploadResult =
  | { ok: true; attachment: UploadedAttachment }
  | { ok: false; code: string; message: string; limit?: string };

export interface UploadedAttachment {
  id: string;
  workItemId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploader: { type: string; id: string; name: string | null };
  createdAt: string;
}

const json = (body: UploadResult, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const STATUS: Record<string, number> = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  denied: 403,
  conflict: 409,
  unavailable: 503,
  unauthenticated: 401,
};

/** Whether the request comes from the app's own pages (same origin), not another site. */
function sameOrigin(request: Request): boolean {
  if (request.headers.get(UPLOAD_HEADER) !== "1") return false;
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  return origin === new URL(request.url).origin;
}

/**
 * Reads at most `max` bytes of the body as it streams in; null as soon as it goes past, so an
 * oversized upload is never buffered whole.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel("too large").catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function handleUpload(
  env: AppEnv,
  request: Request,
  workItemId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, code: "invalid_input", message: "POST only" }, 405);
  }
  if (!sameOrigin(request)) {
    return json({ ok: false, code: "forbidden", message: "cross-site upload refused" }, 403);
  }
  const user = await userFromRequest(env, request.headers);
  if (!user) {
    return json(
      { ok: false, code: "unauthenticated", message: "Your session has ended. Sign in again." },
      401,
    );
  }
  const max = ATTACHMENT_LIMITS.maxFileBytes;
  const declared = Number(request.headers.get("content-length") ?? "0");
  const tooBig = {
    ok: false as const,
    code: "invalid_input",
    limit: "maxFileBytes",
    message: `the file is over the limit per file (maxFileBytes) of ${max} bytes`,
  };
  if (declared > max) return json(tooBig, 413);
  const bytes = await readCapped(request.body, max);
  if (!bytes) return json(tooBig, 413);

  let filename = "file";
  try {
    filename = decodeURIComponent(request.headers.get("x-filename") ?? "file");
  } catch {
    filename = "file";
  }
  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
  const response = await env.ENGINE.invoke(
    "workItem.attachment.add",
    {
      workItemId,
      filename,
      contentType: request.headers.get("content-type") ?? "",
      bytes,
    },
    {
      actor: { type: "human", id: user.id },
      origin: { surface: "app", requestId: crypto.randomUUID() },
      ...(idempotencyKey && idempotencyKey.length >= 8 && idempotencyKey.length <= 200
        ? { idempotencyKey: `upload:${idempotencyKey}` }
        : {}),
    },
  );
  if (!response.ok) {
    const limit = response.error.details?.limit;
    return json(
      {
        ok: false,
        code: response.error.code,
        message: response.error.message,
        ...(typeof limit === "string" ? { limit } : {}),
      },
      STATUS[response.error.code] ?? 400,
    );
  }
  if (response.result.status !== "ok") {
    return json({ ok: false, code: "conflict", message: "upload is waiting for approval" }, 409);
  }
  const output = response.result.output as { attachment: UploadedAttachment };
  return json({ ok: true, attachment: output.attachment }, 201);
}

const NOT_FOUND = () =>
  new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });

/**
 * Serves one attachment to someone who may see it. Signed out, outside the org, or missing: the
 * same 404, so ids can't be probed.
 */
export async function handleServe(
  env: AppEnv,
  request: Request,
  attachmentId: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const user = await userFromRequest(env, request.headers);
  if (!user) return NOT_FOUND();
  const response = await env.ENGINE.invoke(
    "workItem.attachment.get",
    { attachmentId, withBytes: request.method === "GET" },
    {
      actor: { type: "human", id: user.id },
      origin: { surface: "app", requestId: crypto.randomUUID() },
    },
  );
  if (!response.ok || response.result.status !== "ok") return NOT_FOUND();
  const { attachment, bytes } = response.result.output as {
    attachment: UploadedAttachment;
    bytes: Uint8Array | null;
  };
  const headers = attachmentResponseHeaders(attachment);
  if (request.method === "HEAD" || !bytes) return new Response(null, { status: 200, headers });
  return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers });
}

/** Routes an attachment request, or returns null when the path is not one of ours. */
export function routeAttachments(env: AppEnv, request: Request): Promise<Response> | null {
  const { pathname } = new URL(request.url);
  const upload = pathname.match(UPLOAD_PATH);
  if (upload?.[1]) return handleUpload(env, request, upload[1]);
  const serve = pathname.match(SERVE_PATH);
  if (serve?.[1]) return handleServe(env, request, serve[1]);
  return null;
}
