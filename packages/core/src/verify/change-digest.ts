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
import type { Tree, TreeEntry } from "../services.ts";

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
 * Whether `merged` is made only of its two parents' files: every path is exactly the approved
 * head's entry or the default branch's (absent counts), never a third thing. A file both sides
 * changed fails it (its merge is new content), and so does any crafted edit.
 */
export function onlyEitherSide(approved: Tree, main: Tree, merged: Tree): string[] {
  const third: string[] = [];
  const paths = new Set([...Object.keys(approved), ...Object.keys(main), ...Object.keys(merged)]);
  for (const path of paths) {
    if (!same(merged[path], approved[path]) && !same(merged[path], main[path])) third.push(path);
  }
  return third.sort();
}

/**
 * Owner question 1 (spec 53), the recommended answer, not yet confirmed: an approval survives a
 * merge of the default branch only when that merge is the one the factory asked GitHub for, made
 * of its two parents' files only, and the change is identical. One function, so a different answer
 * ("every new head goes back to a person") is a change here: return false.
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
