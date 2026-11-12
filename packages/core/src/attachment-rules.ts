// Attachment rules a view needs too (ADR 0310): the limits, the allowed and inline types, and a
// pasted image's name. No imports and no runtime APIs, so the desktop app's view and sf-app's pages
// can use them without pulling in the blob store (attachments.ts re-exports them).

/** The limits, in one place (spec wi-1). */
export const ATTACHMENT_LIMITS = {
  /** Largest single file. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Most attachments on one work item. */
  maxPerItem: 20,
  /** Most bytes across one work item's attachments. */
  maxTotalBytesPerItem: 50 * 1024 * 1024,
  /** Longest filename kept (characters, after sanitising). */
  maxFilenameLength: 200,
} as const;

/** The content types v1 accepts. SVG and HTML never: they can carry script. */
export const ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "application/pdf",
  "application/json",
] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

/** Types served `inline` (rendered by the browser as an image); everything else is a download. */
export const INLINE_CONTENT_TYPES: readonly AttachmentContentType[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/** `pasted-image-<timestamp>.png`: the name a pasted clipboard image gets. */
export function pastedImageName(now: Date, contentType = "image/png"): string {
  const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  return `pasted-image-${stamp}.${ext}`;
}

