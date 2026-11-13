// More than one merge base, from GitHub's compare data (review of #175, round 4). GitHub reports a
// single merge base, the same both ways, even for a criss-cross; the boundary parents tell.
import { describe, expect, it } from "vitest";
import { mergeBaseAmbiguousFrom, type SinceBase } from "../src/index.ts";
import recorded from "./fixtures/criss-cross-compare.json" with { type: "json" };

type Listing = { merge_base: string; total_commits: number; commits: SinceBase["commits"] };
const since = (l: Listing): SinceBase => ({
  base: l.merge_base,
  total: l.total_commits,
  commits: l.commits,
});
const ancestry = recorded.ancestorOfBase as Record<string, boolean>;

describe("mergeBaseAmbiguousFrom", () => {
  it("finds a real criss-cross GitHub reports with one base both ways", async () => {
    const a = since(recorded.branchSinceBase as Listing);
    const b = since(recorded.mainSinceBase as Listing);
    expect(a.base).toBe(b.base);
    expect(await mergeBaseAmbiguousFrom(a, b, async (sha) => ancestry[sha] ?? null)).toBe(true);
  });

  it("is false when every boundary parent is the base or behind it (an item that merged main)", async () => {
    // base B; the item: I1 (parent B), M (a merge of main's X, behind B, and I1); main: N (parent B).
    const a: SinceBase = {
      base: "B",
      total: 2,
      commits: [
        { sha: "I1", parents: ["B"] },
        { sha: "M", parents: ["I1", "X"] },
      ],
    };
    const b: SinceBase = { base: "B", total: 1, commits: [{ sha: "N", parents: ["B"] }] };
    expect(await mergeBaseAmbiguousFrom(a, b, async (sha) => sha === "X")).toBe(false);
  });

  it("can't tell (null) when a listing is truncated, or an ancestry can't be read", async () => {
    const a: SinceBase = { base: "B", total: 300, commits: [{ sha: "I1", parents: ["B"] }] };
    const b: SinceBase = { base: "B", total: 1, commits: [{ sha: "N", parents: ["Z"] }] };
    expect(await mergeBaseAmbiguousFrom(a, b, async () => true)).toBeNull();
    expect(await mergeBaseAmbiguousFrom({ ...a, total: 1 }, b, async () => null)).toBeNull();
  });
});
