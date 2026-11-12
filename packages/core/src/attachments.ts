// Work item attachments (ADR 0310): the limits, the content-type allow-list and sniffing, filename
// sanitising, the blob store the operations write through (R2 on sf-engine), and the headers every
// served file carries. One place, so the operations, the upload endpoint and the serving route agree.
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_LIMITS,
  type AttachmentContentType,
  INLINE_CONTENT_TYPES,
} from "./attachment-rules.ts";
import { OperationError } from "./errors.ts";

export {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_LIMITS,
  type AttachmentContentType,
  INLINE_CONTENT_TYPES,
  pastedImageName,
} from "./attachment-rules.ts";

/** Which limit an upload broke, as the refusal's `details.limit`. */
export type AttachmentLimit =
  | "maxFileBytes"
  | "maxPerItem"
  | "maxTotalBytesPerItem"
  | "contentType"
  | "contentMismatch"
  | "empty";

/** A refusal naming the limit (`invalid_input`, `details.limit`). Nothing has been stored. */
export function attachmentRejected(
  limit: AttachmentLimit,
  message: string,
  extra: Record<string, unknown> = {},
): OperationError {
  return new OperationError("invalid_input", message, { limit, ...extra });
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** Markup a browser would render: never accepted, even declared as text. */
const MARKUP = /^\s*<(!doctype\s+html|html|svg|\?xml|script|head|body|iframe|object|embed)\b/i;

/**
 * Whether `bytes` really are `declared`, by their leading bytes (images, PDF) or by decoding them
 * (text must be UTF-8 with no NUL and not markup; JSON must parse). Returns the reason on mismatch.
 */
export function sniffMismatch(declared: AttachmentContentType, bytes: Uint8Array): string | null {
  switch (declared) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? null
        : "not a PNG";
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]) ? null : "not a JPEG";
    case "image/gif":
      return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))
        ? null
        : "not a GIF";
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)
        ? null
        : "not a WebP image";
    case "application/pdf":
      return startsWith(bytes, ascii("%PDF-")) ? null : "not a PDF";
    case "text/plain":
    case "application/json": {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        return "not UTF-8 text";
      }
      if (text.includes("\u0000")) return "binary content declared as text";
      if (MARKUP.test(text.replace(/^\uFEFF/, ""))) return "HTML, SVG or XML markup";
      if (declared === "application/json") {
        try {
          JSON.parse(text);
        } catch {
          return "not valid JSON";
        }
      }
      return null;
    }
  }
}

/** Lowercased, parameters dropped (`text/plain; charset=utf-8` → `text/plain`). */
export function normaliseContentType(raw: string): string {
  return raw.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isAllowedContentType(type: string): type is AttachmentContentType {
  return (ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(type);
}

/**
 * A display name safe to store and show: no directories, no control or bidi characters, no leading
 * dots, at most `maxFilenameLength` characters. It is never a storage key or a path.
 */
export function sanitiseFilename(raw: string): string {
  const base = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = [...base]
    .filter((c) => !isHiddenChar(c.charCodeAt(0)))
    .join("")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, ATTACHMENT_LIMITS.maxFilenameLength)
    .trim();
  return cleaned || "file";
}

/** C0/C1 controls, and the bidi marks, overrides and isolates that can disguise an extension. */
function isHiddenChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f
  );
}

/** Where an attachment's bytes live: by org, work item and attachment id, never by filename. */
export function attachmentBlobKey(orgId: string, workItemId: string, attachmentId: string): string {
  return `${orgId}/${workItemId}/${attachmentId}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // The cast: every Uint8Array here is backed by an ArrayBuffer (DOM and workers typings disagree).
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the operations need from blob storage. sf-engine backs it with R2 (`r2AttachmentBlobs`). */
export interface AttachmentBlobs {
  put(key: string, bytes: Uint8Array, meta: { contentType: string; sha256: string }): Promise<void>;
  /** The bytes, or null when there is no blob. */
  get(key: string): Promise<Uint8Array | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Keys under `prefix` with their upload time, a page at a time (for the stray-blob sweep). */
  list(options: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ keys: { key: string; uploaded: Date }[]; cursor: string | null }>;
}

export function r2AttachmentBlobs(bucket: R2Bucket): AttachmentBlobs {
  return {
    async put(key, bytes, meta) {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: meta.contentType },
        customMetadata: { sha256: meta.sha256 },
        sha256: meta.sha256,
      });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list({ prefix, cursor }) {
      const page = await bucket.list({
        ...(prefix ? { prefix } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 500,
      });
      return {
        keys: page.objects.map((o) => ({ key: o.key, uploaded: o.uploaded })),
        cursor: page.truncated ? page.cursor : null,
      };
    },
  };
}

/** `attachment; filename="…"; filename*=UTF-8''…`, quoting nothing a header could be split on. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = sanitiseFilename(filename)
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;]/g, "_");
  const encoded = encodeURIComponent(sanitiseFilename(filename)).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * The headers on every served attachment (ADR 0310): the stored, validated type (never the
 * browser's guess), nosniff, inline only for images, a sandboxing CSP and private caching.
 */
export function attachmentResponseHeaders(attachment: {
  contentType: string;
  filename: string;
  sizeBytes: number;
}): Record<string, string> {
  const type = isAllowedContentType(attachment.contentType)
    ? attachment.contentType
    : "application/octet-stream";
  const inline = (INLINE_CONTENT_TYPES as readonly string[]).includes(type);
  return {
    "content-type": type === "text/plain" ? "text/plain; charset=utf-8" : type,
    "content-length": String(attachment.sizeBytes),
    "x-content-type-options": "nosniff",
    "content-disposition": contentDisposition(
      inline ? "inline" : "attachment",
      attachment.filename,
    ),
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, max-age=0, must-revalidate",
    "cross-origin-resource-policy": "same-origin",
  };
}
