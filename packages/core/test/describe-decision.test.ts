// What a presence prompt says (spec 40 M4b): the engine's facts first, a title last, cleaned and
// cut so a title can't hide or push off the facts, nor make an item undecidable on the desktop.
import { describe, expect, it } from "vitest";
import { cleanTitle, MAX_SUMMARY, titled } from "../src/index.ts";

const MERGE = "Merge 3f2a91c into main of acme/widgets, without its checks:";

describe("presence summaries", () => {
  it("keep the facts first and quote the title last", () => {
    expect(titled(MERGE, "Fix the inbox count")).toBe(
      'Merge 3f2a91c into main of acme/widgets, without its checks: "Fix the inbox count"',
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

  it("stay within the limit whatever the title, the facts whole", () => {
    const long = titled(MERGE, "x".repeat(500));
    expect([...long].length).toBeLessThanOrEqual(MAX_SUMMARY);
    expect(long.startsWith(MERGE)).toBe(true);
    expect(long).toMatch(/…"$/);
    expect([...titled("Approve", "é".repeat(300))].length).toBeLessThanOrEqual(MAX_SUMMARY);
  });
  it("never cut the facts, and show a label only with its title (config summaries)", () => {
    const facts =
      "Approve a change to the policy (v2 to v3): loosens: Autonomy policy Balanced → Autonomous; agent spend: review → allow";
    expect(titled(facts, "Acme", "; project")).toBe(facts);
    const short = "Approve a change to the policy (v2 to v3): loosens: Autonomy policy";
    expect(titled(short, "Ac\u200bme", "; project")).toBe(`${short}; project "Acme"`);
    expect(titled(short, "", "; project")).toBe(short);
  });
});
