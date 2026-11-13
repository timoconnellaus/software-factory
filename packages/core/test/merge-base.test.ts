// More than one merge base, from GitHub's compare data (review of #175, round 4). GitHub reports a
// single merge base, the same both ways, even for a criss-cross; the boundary parents tell.
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_BATCH,
  MAX_BOUNDARY_CHECKS,
  MERGE_BASE_UNKNOWN,
  type MergeBaseUnknown,
  mergeBaseAmbiguousFrom,
  type SinceBase,
} from "../src/index.ts";
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

  it("says why it can't tell: a truncated listing, an unreadable ancestry or compare", async () => {
    const a: SinceBase = { base: "B", total: 300, commits: [{ sha: "I1", parents: ["B"] }] };
    const b: SinceBase = { base: "B", total: 1, commits: [{ sha: "N", parents: ["Z"] }] };
    expect(await mergeBaseAmbiguousFrom(a, b, async () => true)).toBe("truncated");
    expect(await mergeBaseAmbiguousFrom({ ...a, total: 1 }, b, async () => null)).toBe(
      "unreadable",
    );
    expect(await mergeBaseAmbiguousFrom(null, b, async () => true)).toBe("unreadable");
    expect(await mergeBaseAmbiguousFrom({ ...a, base: null }, b, async () => true)).toBe(
      "unreadable",
    );
  });

  // Review of #175: past the cap it says so (not "too many commits"), and checks run in batches.
  const merges = (n: number): SinceBase => ({
    base: "B",
    total: n,
    commits: Array.from({ length: n }, (_, i) => ({ sha: `M${i}`, parents: ["B", `X${i}`] })),
  });
  const one: SinceBase = { base: "B", total: 1, commits: [{ sha: "N", parents: ["B"] }] };

  it("checks up to MAX_BOUNDARY_CHECKS boundary parents, BOUNDARY_BATCH at a time, in parallel", async () => {
    let inFlight = 0;
    let most = 0;
    const answer = await mergeBaseAmbiguousFrom(merges(MAX_BOUNDARY_CHECKS), one, async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return true;
    });
    expect(answer).toBe(false);
    expect(most).toBe(BOUNDARY_BATCH);
  });

  it("says too-many past the cap, without asking GitHub", async () => {
    let asked = 0;
    const answer = await mergeBaseAmbiguousFrom(merges(MAX_BOUNDARY_CHECKS + 1), one, async () => {
      asked++;
      return true;
    });
    expect(answer).toBe("too-many");
    expect(asked).toBe(0);
    expect(MERGE_BASE_UNKNOWN[answer as MergeBaseUnknown]).toMatch(/too many merges/);
  });
});
