// Attachments in the desktop (ADR 0310, spec 40 M3). The view reads the file and sends its bytes
// through the client door as `{ $bytes: base64 }` (`workItem.attachment.add`); the engine checks
// limits, types and sniffs the bytes as for any upload. Files come back the same way
// (`workItem.attachment.get`) and are shown from a blob URL: the door has no file URLs.
import { declaredType } from "@software-factory/client/attachments";
import type { Attachment } from "@software-factory/client/ops";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { OpError, op } from "./op.ts";
import { attachmentBytesQuery } from "./queries.ts";

export * from "@software-factory/client/attachments";

export type UploadResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; code: string; message: string };

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface UploadOptions {
  /** Called with 1 once the file is stored (the RPC has no progress events). */
  onProgress?: (fraction: number) => void;
}

/** Uploads one file to a work item. Resolves with the engine's answer; never throws on a refusal. */
export async function uploadAttachment(
  workItemId: string,
  file: File,
  options: UploadOptions = {},
): Promise<UploadResult> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { attachment } = await op(
      "workItem.attachment.add",
      // The door decodes `{ $bytes }` into the Uint8Array the operation takes.
      {
        workItemId,
        filename: file.name,
        contentType: declaredType(file),
        bytes: { $bytes: toBase64(bytes) } as unknown as Uint8Array,
      },
      { idempotencyKey: `upload:${crypto.randomUUID()}` },
    );
    options.onProgress?.(1);
    return { ok: true, attachment };
  } catch (error) {
    return error instanceof OpError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: "network", message: String(error) };
  }
}

/** A blob URL for an attachment's bytes, revoked when the component goes. Null while loading. */
export function useAttachmentUrl(attachment: Pick<Attachment, "id" | "contentType">) {
  const bytes = useQuery(attachmentBytesQuery(attachment.id));
  const [url, setUrl] = useState<string | null>(null);
  const wire = bytes.data?.bytes as unknown as { $bytes: string } | null | undefined;
  useEffect(() => {
    if (!wire) return;
    const u = URL.createObjectURL(
      new Blob([fromBase64(wire.$bytes)], { type: attachment.contentType }),
    );
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [wire, attachment.contentType]);
  return { url, error: bytes.error };
}
