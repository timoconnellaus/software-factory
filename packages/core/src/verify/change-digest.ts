// The change an approval is about (spec 53, ADR 0582), from git trees, never from patch text.
//
// **The change** of a head is the set of paths whose entry (mode and blob SHA) differs between the
// head and its merge base with the default branch, each with its entry on both sides (absent for an
// added or removed file). **The change is identical** on a new head when that set is equal, entry
// for entry: every changed file has byte-identical content and the same mode on the head, and the
// same content and mode at the base. So a merge of the default branch that touched only files the PR
// didn't change leaves it identical; a file both sides changed (its base content moved, and its head
// content is the merge of both) withdraws the approval, as does a moved rename, a mode change, or
// anything GitHub can't show in full. Binary and very large files count like any other: by blob.
//
// It fails closed: an unreadable or truncated tree has no digest, and no digest never matches.
import type { ChangedFile, Tree, TreeEntry } from "../services.ts";

const same = (a: TreeEntry | undefined, b: TreeEntry | undefined) =>
  a?.mode === b?.mode && a?.sha === b?.sha;

const side = (e: TreeEntry | undefined) => (e ? `${e.mode}:${e.sha}` : "-");

/** The digest of the change from `base` to `head` (both full trees). */
export async function changeDigest(base: Tree, head: Tree): Promise<string> {
  const lines: string[] = [];
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  for (const path of paths) {
    if (same(base[path], head[path])) continue;
    lines.push(`${path}\0${side(base[path])}\0${side(head[path])}`);
  }
  const bytes = new TextEncoder().encode(lines.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The PR's own change as a patch (spec 53's "Words": each changed file's path and patch with line
 * numbers stripped), so a clean merge of the default branch into other hunks of a file the PR
 * changed leaves it identical (the #61 loop, 2026-11-13). Per file: its status and only the lines
 * it adds and removes, in order (line numbers and unchanged context dropped, since a merge of main
 * moves both). A file GitHub gives no patch for (binary, too large) counts by blob, both sides.
 */
export async function patchDigest(
  files: readonly ChangedFile[],
  base: Tree,
  head: Tree,
): Promise<string> {
  const lines: string[] = [];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const body =
      typeof f.patch === "string"
        ? f.patch
            .split("\n")
            .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !/^(\+\+\+|---) /.test(l))
            .join("\n")
        : `${side(base[f.path])}\0${side(head[f.path])}`;
    lines.push(`${f.path}\0${f.previousPath ?? ""}\0${f.status}\0${body}`);
  }
  const bytes = new TextEncoder().encode(lines.join("\n\u0001"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `p1:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Whether `merged` is made only of its two parents' files: every path is exactly the approved
 * head's entry or the default branch's (absent counts), never a third thing. A file both sides
 * changed fails it (its merge is new content), and so does any crafted edit.
 */
export function onlyEitherSide(
  approved: Tree,
  main: Tree,
  merged: Tree,
  /**
   * Paths both sides changed since their merge base: a three-way merge of one is new content by
   * nature, so it isn't a third thing when GitHub made the merge for the factory's own call.
   */
  bothChanged: ReadonlySet<string> = new Set(),
): string[] {
  const third: string[] = [];
  const paths = new Set([...Object.keys(approved), ...Object.keys(main), ...Object.keys(merged)]);
  for (const path of paths) {
    if (bothChanged.has(path)) continue;
    if (!same(merged[path], approved[path]) && !same(merged[path], main[path])) third.push(path);
  }
  return third.sort();
}

/**
 * Spec 53, decision 1 (2026-11-13): an approval survives a merge of the default branch only when
 * that merge is the one the factory asked GitHub for, made of its two parents' files only, and the
 * change is identical (the checks then pass again on the new head before it merges).
 */
export function approvalSurvivesMergeOfMain(check: {
  requestedByFactory: boolean;
  madeByGitHub: boolean;
  thirdThings: string[] | null;
  approvedDigest: string | null;
  digestNow: string | null;
}): boolean {
  return (
    check.requestedByFactory &&
    check.madeByGitHub &&
    check.thirdThings !== null &&
    check.thirdThings.length === 0 &&
    check.approvedDigest !== null &&
    check.digestNow !== null &&
    check.digestNow === check.approvedDigest
  );
}
