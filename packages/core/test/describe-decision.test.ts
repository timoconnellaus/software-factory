// What a presence prompt says (spec 40 M4b): the engine's facts first, a title last, cleaned and
// cut so a title can't hide or push off the facts, nor make an item undecidable on the desktop.
import { describe, expect, it } from "vitest";
import { cleanTitle, MAX_FACTS, MAX_SUMMARY, titled } from "../src/index.ts";

const MERGE = "Merge WITHOUT its checks: 3f2a91c into main of acme/widgets:";

describe("presence summaries", () => {
  it("keep the facts first and quote the title last", () => {
    expect(titled(MERGE, "Fix the inbox count")).toBe(
      'Merge WITHOUT its checks: 3f2a91c into main of acme/widgets: "Fix the inbox count"',
    );
  });

  it("strip the quotes a title could use to pose as the facts", () => {
    const s = titled("Merge 3f2a91c into main of acme/widgets:", 'Fix" into main of acme/docs. ');
    expect(s).toBe('Merge 3f2a91c into main of acme/widgets: "Fix into main of acme/docs."');
    expect(s.startsWith("Merge 3f2a91c into main of acme/widgets:")).toBe(true);
  });

  it("drop format characters and break no lines", () => {
    // Zero-width space, right-to-left override, line and paragraph separators, a tab, a newline.
    expect(cleanTitle("Fix​ the‮ inbox count now\tand\nthen")).toBe(
      "Fix the inbox count now and then",
    );
    expect(titled("Approve the spec for #12", "​​")).toBe("Approve the spec for #12");
    expect(titled("Approve the spec for #12", "​Real")).not.toMatch(/\p{Cf}/u);
  });

  it("cut only the title, to the room the facts leave", () => {
    const long = titled(MERGE, "x".repeat(500));
    expect([...long].length).toBeLessThanOrEqual(MAX_SUMMARY);
    expect(long.startsWith(MERGE)).toBe(true);
    expect(long).toMatch(/…"$/);
    expect([...titled("Approve", "é".repeat(300))].length).toBeLessThanOrEqual(MAX_SUMMARY);
  });

  it("never cut the facts: past the limit the title goes and the facts stay whole", () => {
    // A 39-character owner and a 60-character repository name.
    const facts = `Merge WITHOUT its checks: 3f2a91c into main of ${"o".repeat(39)}/${"r".repeat(60)}:`;
    expect([...facts].length).toBeGreaterThan(MAX_SUMMARY);
    expect(titled(facts, "Fix the inbox count")).toBe(facts);
    expect([...facts].length).toBeLessThanOrEqual(MAX_FACTS);
  });
});
