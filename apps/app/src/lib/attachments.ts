// Attachments in the browser (ADR 0260): turning a paste, a drop or a picked file into uploads,
// and uploading one file to the app's upload route (which calls `workItem.attachment.add`). The
// server decides what is accepted; the checks here only give a quicker message.
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_LIMITS,
  INLINE_CONTENT_TYPES,
  pastedImageName,
} from "@software-factory/core/attachments";
import type { UploadResult } from "#/server/attachments";

export type { UploadResult };
export { ATTACHMENT_LIMITS };

/** What the file picker accepts. */
export const ACCEPT = ATTACHMENT_CONTENT_TYPES.join(",");

export const uploadUrl = (workItemId: string) => `/api/work/${workItemId}/attachments`;
export const attachmentUrl = (attachmentId: string) => `/api/attachments/${attachmentId}`;

export const isImage = (contentType: string) =>
  (INLINE_CONTENT_TYPES as readonly string[]).includes(contentType);

/** A clipboard screenshot arrives with no name or a generic one (`image.png`). */
const GENERIC_NAME = /^(image|blob)?(\.[a-z0-9]+)?$/i;

/**
 * The files in a paste. Clipboard images get a generated name (`pasted-image-<timestamp>.png`);
 * files copied from a file manager keep theirs. Text pastes give no files.
 */
export function filesFromClipboard(
  data: Pick<DataTransfer, "items"> | null | undefined,
  now = new Date(),
): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.type.startsWith("image/") && GENERIC_NAME.test(file.name)) {
      const stamp = new Date(now.getTime() + files.length);
      files.push(new File([file], pastedImageName(stamp, file.type), { type: file.type }));
    } else {
      files.push(file);
    }
  }
  return files;
}

/** The files in a drop (or a picker's `FileList`). */
export function filesFromList(list: FileList | File[] | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

/** The type the server will be told: the browser's, or one guessed from a few extensions. */
export function declaredType(file: Pick<File, "type" | "name">): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return (
    { txt: "text/plain", log: "text/plain", md: "text/plain", json: "application/json" }[
      ext ?? ""
    ] ?? "application/octet-stream"
  );
}

/** A quick refusal before uploading (the server checks again, and sniffs the bytes). */
export function precheck(file: Pick<File, "type" | "name" | "size">): string | null {
  const type = declaredType(file);
  if (!(ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(type)) {
    return `${file.name}: ${type} files aren't allowed (PNG, JPEG, GIF, WebP, text, PDF or JSON only)`;
  }
  if (file.size === 0) return `${file.name} is empty`;
  if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
    return `${file.name} is over the ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)} limit per file`;
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface UploadOptions {
  /** Called with 0–1 as the bytes go up (XMLHttpRequest in the browser). */
  onProgress?: (fraction: number) => void;
  /** Used instead of XMLHttpRequest (tests, or where there is none): no progress events. */
  fetch?: typeof fetch;
  /** The page's origin, for building the URL outside a browser. */
  origin?: string;
}

/** Uploads one file to a work item. Resolves with the server's answer; never throws on a refusal. */
export async function uploadAttachment(
  workItemId: string,
  file: File,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const url = options.origin
    ? new URL(uploadUrl(workItemId), options.origin).href
    : uploadUrl(workItemId);
  const headers: Record<string, string> = {
    "content-type": declaredType(file),
    "x-filename": encodeURIComponent(file.name),
    "x-sf-upload": "1",
    "idempotency-key": crypto.randomUUID(),
  };
  if (options.fetch || typeof XMLHttpRequest === "undefined") {
    const doFetch = options.fetch ?? fetch;
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: options.origin ? { ...headers, origin: options.origin } : headers,
        body: file,
        credentials: "same-origin",
      });
      options.onProgress?.(1);
      return (await response.json()) as UploadResult;
    } catch (error) {
      return { ok: false, code: "network", message: String(error) };
    }
  }
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as UploadResult);
      } catch {
        resolve({ ok: false, code: "network", message: `upload failed (HTTP ${xhr.status})` });
      }
    };
    xhr.onerror = () => resolve({ ok: false, code: "network", message: "the upload failed" });
    xhr.send(file);
  });
}
