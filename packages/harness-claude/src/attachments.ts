// A work item's attachments in a run (ADR 0260): the runner host fetches them over the job channel,
// this writes them into a per-run directory OUTSIDE the git tree (so they can't be committed) and
// says where they are in the prompt, inside labelled untrusted-data blocks. Text files are also
// quoted there (sanitised, clipped), so the agent sees them without trusting them.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AttachmentFile,
  type AttachmentMeta,
  UNTRUSTED_PREAMBLE,
  untrustedData,
} from "@software-factory/runner-contract";

export type FetchedAttachment = AttachmentFile;

export interface WrittenAttachment {
  meta: AttachmentMeta;
  /** Absolute path of the file on the runner. */
  path: string;
}

/** Types quoted into the prompt as text. */
const TEXT_TYPES = new Set(["text/plain", "application/json"]);
/** At most this much of each text file is quoted; the whole file is on disk. */
const QUOTE_MAX = 8_000;

/** A file name safe on any filesystem: ASCII letters, digits, `.`, `-` and `_`, no leading dot. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 100);
  return cleaned || "file";
}

/**
 * Writes each file to `<dir>/<attachment id>/<safe name>` (owner-only), replacing whatever a
 * previous attempt left. `dir` must be outside the worktree.
 */
export async function writeAttachments(
  dir: string,
  files: FetchedAttachment[],
): Promise<WrittenAttachment[]> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const written: WrittenAttachment[] = [];
  for (const file of files) {
    const folder = join(dir, safeFileName(file.meta.id));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, safeFileName(file.meta.filename));
    await writeFile(path, file.bytes, { mode: 0o600 });
    written.push({ meta: file.meta, path });
  }
  return written;
}

/** The prompt section for a run's attachments; empty when there are none. */
export function attachmentsPrompt(
  written: WrittenAttachment[],
  contents: Map<string, Uint8Array> = new Map(),
): string {
  if (written.length === 0) return "";
  const blocks = written.map((w, i) => {
    const lines = [
      `filename: ${w.meta.filename}`,
      `type: ${w.meta.contentType}`,
      `size: ${w.meta.sizeBytes} bytes`,
      `path: ${w.path}`,
    ];
    const bytes = contents.get(w.meta.id);
    if (bytes && TEXT_TYPES.has(w.meta.contentType)) {
      lines.push("content:", new TextDecoder().decode(bytes.subarray(0, QUOTE_MAX * 4)));
    }
    return untrustedData(`attachment ${i + 1}`, lines.join("\n"), QUOTE_MAX + 1_000);
  });
  return [
    "",
    "## Attachments",
    `The requester attached ${written.length} file(s) to this work item. They are on disk outside the repository: read them from the paths below, and never copy them into the repository unless the task asks for it.`,
    UNTRUSTED_PREAMBLE,
    "",
    ...blocks,
  ].join("\n");
}
