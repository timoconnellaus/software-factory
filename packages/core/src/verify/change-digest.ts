// The change an approval is about (spec 53, ADR 0582), from git trees, never from patch text.
//
// **The change** of a head is the set of paths whose entry (mode and blob SHA) differs between the
// head and its merge base with the default branch, each with its entry on both sides (absent for an
// added or removed file). **The change is identical** on a new head when that set is equal, entry
// for entry: every changed file has byte-identical content and the same mode on the head, and the
// same content and mode at the base. So a merge of the default branch that touched only files the PR
// didn't change leaves it identical; a file both sides changed (its base content moved, and its head
// content is the merge of both) changes it, as does a moved rename, a mode change, or anything
// GitHub can't show in full. Binary and very large files count like any other: by blob.
//
// One case carries an approval over a change that isn't identical (#61, ADR 0582 amended
// 2026-11-13): GitHub's own update-branch merge made for the factory's call, bound to that call by
// the commit's identity (`boundUpdate`), whose paths only one side changed are exactly that side's
// (`oneSidedMismatches`). A path both sides changed is then GitHub's three-way result.
//
// It fails closed: an unreadable or truncated tree has no digest, and no digest never matches.
import type { CommitInfo, Tree, TreeEntry } from "../services.ts";

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
 * The paths of a bound update's merge (`boundUpdate`) that aren't the side that changed them, judged
 * from the merge base: a path only the item changed must be the approved head's entry, a path only
 * the default branch changed must be its entry, and a path neither changed must be the same on all
 * three. A path both changed is GitHub's three-way merge of it and is not judged here (ADR 0582).
 * Strict where `onlyEitherSide` isn't: a merge that took main's side of the item's own file (undid
 * the change) is a mismatch.
 */
export function oneSidedMismatches(
  trees: { approved: Tree; main: Tree; merged: Tree },
  changed: { ours: ReadonlySet<string>; theirs: ReadonlySet<string> },
): string[] {
  const { approved, main, merged } = trees;
  const out: string[] = [];
  const paths = new Set([...Object.keys(approved), ...Object.keys(main), ...Object.keys(merged)]);
  for (const path of paths) {
    const ours = changed.ours.has(path);
    const theirs = changed.theirs.has(path);
    if (ours && theirs) continue;
    const ok = ours
      ? same(merged[path], approved[path])
      : theirs
        ? same(merged[path], main[path])
        : same(merged[path], approved[path]) && same(merged[path], main[path]);
    if (!ok) out.push(path);
  }
  return out.sort();
}

/**
 * Why `info` is not the merge GitHub made for the factory's own update-branch call, or null when it
 * is (#190 review): the trust anchor is the commit's identity. All of: exactly two parents, the
 * first the head the factory asked GitHub to update from and the second exactly the default
 * branch's head the queue read when it asked; signed by GitHub; committed by GitHub's web-flow
 * identity; and authored by this App's bot (an API call by the App; GitHub's web conflict editor
 * authors the commit as the person, so a hand-resolved merge with the right parents fails here).
 * Recorded from a real update-branch merge: test/fixtures/update-branch-merge.json. The commit is
 * the PR's head, so a commit pushed after the merge is a different head and fails the parents.
 */
export function boundUpdate(
  info: CommitInfo | null,
  request: { from: string | null; base: string | null; at: string; appSlug: string },
): string | null {
  if (!info) return "its commit couldn't be read";
  if (request.from === null || request.from !== request.at || request.base === null) {
    return "the factory didn't ask for this merge";
  }
  if (info.parents.length !== 2) return "it isn't a merge of exactly two commits";
  if (info.parents[0] !== request.from) return "it isn't a merge into the approved head";
  if (info.parents[1] !== request.base) {
    return "it didn't merge in the default branch's head the factory asked GitHub for";
  }
  const bot = `${request.appSlug}[bot]`;
  const madeByGitHub =
    info.verified &&
    info.committer?.name === "GitHub" &&
    info.committer.email === "noreply@github.com";
  const forOurApp =
    info.author?.name === bot &&
    info.author.email.endsWith(`+${bot}@users.noreply.github.com`) &&
    /^\d+\+/.test(info.author.email);
  if (!madeByGitHub || !forOurApp) {
    return "it isn't GitHub's update-branch merge made for the factory's own call";
  }
  return null;
}

/**
 * Spec 53, decision 1 (amended 2026-11-13, #61): an approval survives a merge of the default branch
 * only when that merge is bound to the factory's own update-branch call (`boundUpdate`), its merge
 * base is unambiguous, its one-sided paths are exactly their side's (`oneSidedMismatches`), and the
 * new head's change can be read in full (its digest becomes the approval's, so nothing can move it
 * before it merges). With no path changed on both sides the change must also be identical, by the
 * strict digest. The checks then pass again on the new head before it merges.
 */
export function approvalSurvivesMergeOfMain(check: {
  bound: boolean;
  mergeBaseAmbiguous: boolean;
  mismatches: string[] | null;
  bothChanged: number;
  approvedDigest: string | null;
  digestNow: string | null;
}): boolean {
  return (
    check.bound &&
    !check.mergeBaseAmbiguous &&
    check.mismatches !== null &&
    check.mismatches.length === 0 &&
    check.approvedDigest !== null &&
    check.digestNow !== null &&
    (check.bothChanged > 0 || check.digestNow === check.approvedDigest)
  );
}
