// The key helper's compiled-in list of operations a presence proof decides (spec 40 M4b) is the
// registry's: a new presence-decidable op that the helper doesn't know would be refused by it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { entitlementProblems, expiry } from "../scripts/check-profile.ts";
import {
  desktopPresenceOps,
  PRESENCE_OPS_SWIFT,
  presenceOpsSwift,
} from "../scripts/presence-ops.ts";

describe("the key helper's presence ops", () => {
  it("match the registry's desktop presence-decidable operations", () => {
    const want = presenceOpsSwift(desktopPresenceOps());
    if (process.env.SF_WRITE_PRESENCE_OPS) writeFileSync(PRESENCE_OPS_SWIFT, want);
    expect(existsSync(PRESENCE_OPS_SWIFT)).toBe(true);
    expect(readFileSync(PRESENCE_OPS_SWIFT, "utf8")).toBe(want);
  });

  it("include the gate decisions and nothing browser-only", () => {
    const ops = desktopPresenceOps();
    expect(ops).toContain("review.merge");
    expect(ops).toContain("spec.approve");
    expect(ops.length).toBeGreaterThan(3);
  });
});

describe("the helper's entitlements against its profile (spec 40 M4b)", () => {
  const TEAM = "ABCDE12345";
  const ID = `${TEAM}.com.software-factory.desktop.keys`;
  // The Entitlements of a Developer ID profile for the helper's App ID, as the portal makes it.
  const profile = {
    "com.apple.application-identifier": ID,
    "keychain-access-groups": [`${TEAM}.*`],
    "com.apple.developer.team-identifier": TEAM,
  };
  const claimed = {
    "com.apple.application-identifier": ID,
    "com.apple.developer.team-identifier": TEAM,
    "keychain-access-groups": [ID],
  };

  it("allows the helper's three entitlements, the group through the team wildcard", () => {
    expect(entitlementProblems(claimed, profile)).toEqual([]);
  });

  it("refuses a profile for a mistyped App ID", () => {
    const typo = {
      ...profile,
      "com.apple.application-identifier": `${TEAM}.om.software-factory.desktop.keys`,
    };
    expect(entitlementProblems(claimed, typo)).toEqual([
      expect.stringMatching(/application-identifier .* not allowed/),
    ]);
  });

  it("refuses another team's profile and an entitlement the profile lacks", () => {
    const other = {
      "com.apple.application-identifier": `ZZZZZ99999.com.software-factory.desktop.keys`,
      "keychain-access-groups": ["ZZZZZ99999.*"],
      "com.apple.developer.team-identifier": "ZZZZZ99999",
    };
    expect(entitlementProblems(claimed, other)).toHaveLength(3);
    expect(
      entitlementProblems({ ...claimed, "com.apple.security.cs.allow-jit": true }, profile),
    ).toEqual(["com.apple.security.cs.allow-jit is not in the profile"]);
    expect(entitlementProblems({ ...claimed, "keychain-access-groups": [] }, profile)).toEqual([
      "keychain-access-groups is empty",
    ]);
  });

  it("prints the expiry, warns under 60 days and fails once expired", () => {
    const now = new Date("2026-11-13T00:00:00Z");
    expect(expiry(new Date("2044-11-07T21:47:09Z"), now)).toMatchObject({ level: "ok" });
    expect(expiry(new Date("2026-12-20T00:00:00Z"), now)).toMatchObject({
      level: "warning",
      text: expect.stringContaining("37 days"),
    });
    expect(expiry(new Date("2026-11-01T00:00:00Z"), now)).toMatchObject({ level: "error" });
  });
});
