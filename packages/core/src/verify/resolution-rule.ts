// When merging a head needs the full diff opened first (spec 53 decision 1; #201 reviews): the one
// rule the engine (review.merge) and the desktop (the Inbox card, the Review tab's Merge) both use.
// Pure, with no imports, so a view can import it (`@software-factory/core/resolution-rule`).

/** What the rule reads of a stored resolution (`babysitResolution`). */
export interface ResolutionFacts {
  status: "clean" | "unclean" | "incomplete" | "failed";
  reason: string | null;
  files: readonly { patchOmitted: boolean; patchTruncated: boolean }[];
  outside: readonly string[];
  outsideNotShown?: number | undefined;
  notShown: number;
}

/**
 * Why a person must open the full diff before merging the gate's head, or null when there is
 * nothing to look at beyond what the gate shows. The head needs it when a babysitter resolution
 * produced it, or one produced an earlier head no person has approved since (`resolvedHead`, a
 * commit on top of a resolution), unless it is a clean resolution of this very head read in full:
 * no file outside the conflict, none unlisted, and every listed file's patch shown whole.
 */
export function fullDiffNeeded(at: {
  resolution: ResolutionFacts | null;
  expected: boolean;
  /** The head the babysitter resolved, when it isn't the gate's head. */
  resolvedHead?: string | null | undefined;
}): string | null {
  const r = at.resolution;
  if (!r) {
    if (!at.expected) return null;
    return at.resolvedHead
      ? `the babysitter resolved a conflict in ${at.resolvedHead.slice(0, 7)} and the branch has moved on since, unreviewed`
      : "the babysitter resolved a conflict on this commit, but its resolution couldn't be shown";
  }
  if (r.status !== "clean") {
    return `its resolution couldn't be shown on its own (${r.reason ?? r.status})`;
  }
  const outside = r.outside.length + (r.outsideNotShown ?? 0);
  if (outside > 0) {
    return `${outside === 1 ? "1 file" : `${outside} files`} outside the conflict differ from a plain merge`;
  }
  if (r.notShown > 0) return `${r.notShown} more resolution files aren't listed`;
  const partial = r.files.filter((f) => f.patchOmitted || f.patchTruncated).length;
  if (partial > 0) {
    return `${partial === 1 ? "1 file's patch isn't" : `${partial} files' patches aren't`} shown in full`;
  }
  return null;
}
