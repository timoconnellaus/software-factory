// The Inbox card's Merge says why it is disabled, on hover (the review of PR #132): before the
// packet loads it isn't "only an approver can merge".
import { describe, expect, it } from "vitest";
import { mergeBlocked } from "#/lib/merge-card";

describe("the Inbox merge card's disabled Merge", () => {
  it("says why on hover, and nothing once it can merge", () => {
    expect(mergeBlocked({ loaded: false, canMerge: false, packet: false })).toBe(
      "Loading the review packet: Merge is ready once it has loaded",
    );
    expect(mergeBlocked({ loaded: true, canMerge: false, packet: true })).toBe(
      "Only an approver on this project can merge",
    );
    expect(mergeBlocked({ loaded: true, canMerge: true, packet: false })).toMatch(
      /review packet for this commit hasn't loaded/,
    );
    expect(mergeBlocked({ loaded: true, canMerge: true, packet: true })).toBeUndefined();
  });
});
