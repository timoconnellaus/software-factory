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

/** Most boundary parents checked (one compare each); past it, it can't tell. */
export const MAX_BOUNDARY_CHECKS = 20;

/**
 * True: more than one merge base. False: one. Null: it can't tell (a listing truncated, no base,
 * too many boundary parents, or an ancestry it couldn't read): callers treat null as ambiguous.
 */
export async function mergeBaseAmbiguousFrom(
  a: SinceBase,
  b: SinceBase,
  isAncestorOfBase: (sha: string, base: string) => Promise<boolean | null>,
): Promise<boolean | null> {
  if (!a.base || !b.base) return null;
  if (a.base !== b.base) return true;
  if (a.total > a.commits.length || b.total > b.commits.length) return null;
  const base = a.base;
  const boundary = new Set<string>();
  for (const side of [a, b]) {
    const listed = new Set(side.commits.map((c) => c.sha));
    for (const c of side.commits) {
      for (const p of c.parents) if (!listed.has(p) && p !== base) boundary.add(p);
    }
  }
  if (boundary.size > MAX_BOUNDARY_CHECKS) return null;
  for (const p of boundary) {
    const behind = await isAncestorOfBase(p, base);
    if (behind === null) return null;
    if (!behind) return true;
  }
  return false;
}
