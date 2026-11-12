// The change an approval is about (spec 53, ADR 0582): a digest of a PR's diff against the default
// branch that a clean merge of the default branch into the branch leaves unchanged. Per file, its
// path (and old path) and the lines it adds and removes, in order. Context lines and hunk positions
// are left out: merging the default branch in moves them without changing the change.
import type { ChangedFile } from "../services.ts";

/**
 * The digest, from GitHub's compare of the default branch with the head (the engine's read, never a
 * runner's report). Null when GitHub left out a file's patch (large or binary): the change can't be
 * compared, and the caller falls back to ADR 0330's parent rule.
 */
export async function changeDigest(files: readonly ChangedFile[]): Promise<string | null> {
  const parts: string[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (f.status === "unchanged") continue;
    const lines =
      f.patch === undefined
        ? null
        : f.patch
            .split("\n")
            .filter(
              (l) =>
                (l.startsWith("+") || l.startsWith("-")) &&
                !l.startsWith("+++") &&
                !l.startsWith("---"),
            );
    // A rename or a mode change with no content lines has nothing to compare but its paths.
    if (lines === null && (f.changes ?? 1) > 0) return null;
    parts.push(`${f.status}\0${f.previousPath ?? ""}\0${f.path}\n${(lines ?? []).join("\n")}`);
  }
  const bytes = new TextEncoder().encode(parts.join("\n\0\n"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
