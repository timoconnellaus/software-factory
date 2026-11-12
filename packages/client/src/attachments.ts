// Attachments in a view (ADR 0310): turning a paste, a drop or a picked file into files to upload,
// and a quick check before uploading. The engine decides what is accepted (and sniffs the bytes);
// the checks here only give a quicker message. How the bytes travel is each app's business.
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_LIMITS,
  INLINE_CONTENT_TYPES,
  pastedImageName,
} from "@software-factory/core/attachment-rules";

export { ATTACHMENT_LIMITS };

/** What the file picker accepts. */
export const ACCEPT = ATTACHMENT_CONTENT_TYPES.join(",");

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

