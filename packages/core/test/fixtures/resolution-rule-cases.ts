// The full-diff rule's cases (#201 review): one table, run against core's fullDiffNeeded and the
// desktop's resolutionNeedsFullDiff, so the two can't drift apart.
import type { ResolutionFacts } from "../../src/verify/resolution-rule.ts";

const clean: ResolutionFacts = {
  status: "clean",
  reason: null,
  files: [{ patchOmitted: false, patchTruncated: false }],
  outside: [],
  outsideNotShown: 0,
  notShown: 0,
};

export const RESOLUTION_RULE_CASES: {
  name: string;
  at: { resolution: ResolutionFacts | null; expected: boolean; resolvedHead?: string | null };
  needs: boolean;
}[] = [
  { name: "an ordinary gate", at: { resolution: null, expected: false }, needs: false },
  {
    name: "a clean resolution read in full",
    at: { resolution: clean, expected: true },
    needs: false,
  },
  {
    name: "expected, but no readable record",
    at: { resolution: null, expected: true },
    needs: true,
  },
  {
    name: "a commit on top of an unreviewed resolution",
    at: { resolution: null, expected: true, resolvedHead: "a".repeat(40) },
    needs: true,
  },
  {
    name: "unclean",
    at: { resolution: { ...clean, status: "unclean", reason: "two merge bases" }, expected: true },
    needs: true,
  },
  {
    name: "incomplete",
    at: { resolution: { ...clean, status: "incomplete", reason: "too large" }, expected: true },
    needs: true,
  },
  {
    name: "failed",
    at: { resolution: { ...clean, status: "failed" }, expected: true },
    needs: true,
  },
  {
    name: "a file outside the conflict",
    at: { resolution: { ...clean, outside: ["src/x.ts"] }, expected: true },
    needs: true,
  },
  {
    name: "files outside the conflict past the named ones",
    at: { resolution: { ...clean, outsideNotShown: 1 }, expected: true },
    needs: true,
  },
  {
    name: "resolution files not listed",
    at: { resolution: { ...clean, notShown: 1 }, expected: true },
    needs: true,
  },
  {
    name: "a patch GitHub omitted",
    at: {
      resolution: { ...clean, files: [{ patchOmitted: true, patchTruncated: false }] },
      expected: true,
    },
    needs: true,
  },
  {
    name: "a clipped patch",
    at: {
      resolution: { ...clean, files: [{ patchOmitted: false, patchTruncated: true }] },
      expected: true,
    },
    needs: true,
  },
];
