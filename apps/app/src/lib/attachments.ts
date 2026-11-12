// Attachments in the browser (ADR 0310): turning a paste, a drop or a picked file into uploads,
// and uploading one file to the app's upload route (which calls `workItem.attachment.add`). The
// server decides what is accepted; the checks here only give a quicker message.
import { declaredType } from "@software-factory/client/attachments";
import type { UploadResult } from "#/server/attachments";

export * from "@software-factory/client/attachments";
export type { UploadResult };

export const uploadUrl = (workItemId: string) => `/api/work/${workItemId}/attachments`;
export const attachmentUrl = (attachmentId: string) => `/api/attachments/${attachmentId}`;

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
