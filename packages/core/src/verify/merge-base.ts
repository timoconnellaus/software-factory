// Whether two commits have more than one merge base (review of #175), from what GitHub's compare
// API gives: a merge base (GitHub reports one, the same both ways, even for a criss-cross) and each
// side's commits since it, with their parents. Pure: the GitHub client and the test fake feed it.
//
// Each side's listing is the commits it has that the other doesn't (GitHub's compare lists `head
// ^base`, so the two are disjoint). A parent of a listed commit that isn't listed (a boundary
// parent) is a commit both sides have: it must be the merge base or one of its ancestors. Anything
// else is a second merge base, one GitHub's single answer hides (git merge-base --all shows both).

export interface SinceBase {
  /** GitHub's merge_base_commit. */
  base: string | null;
  /** total_commits: how many commits the compare covers. */
  total: number;
  /** The commits it listed (the head's that the other side doesn't have), with their parents. */
  commits: { sha: string; parents: string[] }[];
}

/**
 * Most boundary parents checked (one compare each, `BOUNDARY_BATCH` at a time); past it, it can't
 * tell. One judgement is at most 62 GitHub calls (two listings and 60 compares). The engine runs on
 * Workers Paid (its wrangler config sets `limits.cpu_ms: 10000`, which only Paid accepts), whose
 * subrequest limit per invocation is 1,000 at the least (Free's is 50): the cap keeps one judgement
 * well inside it, with the rest of a pass. Raise it only with that budget in view.
 */
export const MAX_BOUNDARY_CHECKS = 60;
/** Boundary parents checked at once. */
export const BOUNDARY_BATCH = 10;

/**
 * Why it can't tell (review of #175): GitHub's listing stops before the merge base (`truncated`),
 * more boundary parents than are checked (`too-many`), or GitHub didn't answer (`unreadable`: no
 * merge base, an error). A string, never `false`, so a caller that asks `!== false` fails closed.
 */
export type MergeBaseUnknown = "truncated" | "too-many" | "unreadable";

/** What a person reads for `MergeBaseUnknown`. */
export const MERGE_BASE_UNKNOWN: Record<MergeBaseUnknown, string> = {
  truncated: "too many commits to find the merge base",
  "too-many": "too many merges between the item and the default branch to find the merge base",
  unreadable: "GitHub couldn't be read to find the merge base",
};

/**
 * True: more than one merge base. False: one. Otherwise why it can't tell (`MergeBaseUnknown`):
 * callers treat anything but `false` as ambiguous.
 */
export async function mergeBaseAmbiguousFrom(
  a: SinceBase | null,
  b: SinceBase | null,
  isAncestorOfBase: (sha: string, base: string) => Promise<boolean | null>,
): Promise<boolean | MergeBaseUnknown> {
  if (!a?.base || !b?.base) return "unreadable";
  if (a.base !== b.base) return true;
  if (a.total > a.commits.length || b.total > b.commits.length) return "truncated";
  const base = a.base;
  const boundary = new Set<string>();
  for (const side of [a, b]) {
    const listed = new Set(side.commits.map((c) => c.sha));
    for (const c of side.commits) {
      for (const p of c.parents) if (!listed.has(p) && p !== base) boundary.add(p);
    }
  }
  if (boundary.size > MAX_BOUNDARY_CHECKS) return "too-many";
  const all = [...boundary];
  // In batches, in parallel (review of #175): one round trip per batch, not per parent.
  for (let i = 0; i < all.length; i += BOUNDARY_BATCH) {
    const answers = await Promise.all(
      all.slice(i, i + BOUNDARY_BATCH).map((p) => isAncestorOfBase(p, base)),
    );
    if (answers.includes(false)) return true;
    if (answers.includes(null)) return "unreadable";
  }
  return false;
}
