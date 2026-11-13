// The release scripts (spec 40 M4): what CI uploads, in what order, and what it refuses.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zipPlan } from "../scripts/hook-post-package.ts";
import {
  helperEntitlements,
  helperPlan,
  rewriteManifest,
  smokeVerdict,
} from "../scripts/keys-helper.ts";
import {
  headResult,
  refusal,
  uploadPlan,
  versionedArchive,
  versionedDownload,
} from "../scripts/publish-release.ts";
// @ts-expect-error a plain .mjs build script, without types
import { pinnedNode } from "../scripts/vendor-node.mjs";
import { DOOR_PROTOCOL } from "../src/bun/protocol.ts";

const TAR = "canary-macos-arm64-SoftwareFactory-canary.app.tar.zst";
const manifest = (file = TAR, version = "0.1.7") =>
  JSON.stringify({
    schemaVersion: 1,
    identifier: "com.software-factory.desktop",
    channel: "canary",
    version,
    hash: "abc",
    platform: "macos",
    arch: "arm64",
    artifact: { file, tarSha256: "0".repeat(64), tarSize: 1 },
  });

describe("uploadPlan", () => {
  const files = [
    TAR,
    "canary-macos-arm64-Software-Factory.zip",
    "canary-macos-arm64-update.json",
    "canary-macos-arm64-update-v2.json",
    "stable-macos-arm64-update-v2.json",
  ];
  const written: Record<string, string> = {};
  const plan = uploadPlan(
    files,
    () => manifest(),
    (n, body) => {
      written[n] = body;
      return `/tmp/${n}`;
    },
    "canary",
    "0.1.7",
  );

  it("uploads versioned names first, the v2 manifest after them and the protocol file last", () => {
    expect(plan.map((u) => u.key)).toEqual([
      `desktop/${versionedArchive(TAR, "0.1.7")}`,
      `desktop/${versionedDownload("canary", "0.1.7")}`,
      "desktop/canary-macos-arm64-Software-Factory.zip",
      "desktop/canary-macos-arm64-update.json",
      "desktop/canary-macos-arm64-update-v2.json",
      "desktop/canary-macos-arm64-protocol.json",
    ]);
    expect(JSON.parse(written["canary-macos-arm64-protocol.json"] as string)).toEqual({
      channel: "canary",
      version: "0.1.7",
      protocol: DOOR_PROTOCOL,
    });
    expect(plan[0]?.cacheControl).toMatch(/immutable/);
    expect(plan.at(-1)?.cacheControl).toBe("no-cache");
  });

  it("rewrites the manifests to name the versioned archive", () => {
    const v2 = JSON.parse(written["canary-macos-arm64-update-v2.json"] as string);
    expect(v2.artifact.file).toBe("canary-macos-arm64-SoftwareFactory-canary-0.1.7.app.tar.zst");
    // Electrobun only accepts an archive named with the channel's prefix.
    expect(v2.artifact.file.startsWith("canary-macos-arm64-")).toBe(true);
  });

  it("refuses manifests for another version", () => {
    expect(() =>
      uploadPlan(
        files,
        () => manifest(TAR, "0.1.6"),
        () => "",
        "canary",
        "0.1.7",
      ),
    ).toThrow(/not canary 0.1.7/);
  });
});

describe("refusal", () => {
  it("never overwrites a version or goes backwards", () => {
    expect(refusal("stable", "1.2.0", "1.1.9", false)).toBeNull();
    expect(refusal("stable", "1.2.0", null, false)).toBeNull();
    expect(refusal("stable", "1.2.0", "1.2.0", false)).toMatch(/not higher/);
    expect(refusal("stable", "1.1.0", "1.2.0", false)).toMatch(/not higher/);
    expect(refusal("stable", "1.3.0", "1.2.0", true)).toMatch(/already published/);
    expect(refusal("canary", "0.1.10", "0.1.9", false)).toBeNull();
    expect(refusal("beta", "1.0.0", null, false)).toMatch(/unknown channel/);
    expect(refusal("stable", "v1", null, false)).toMatch(/not a version/);
  });
});

describe("headResult", () => {
  it("is 'not there' only on a real 404, and fails closed on anything else", () => {
    expect(headResult(0, "", "k")).toBe(true);
    expect(
      headResult(
        254,
        "An error occurred (404) when calling the HeadObject operation: Not Found",
        "k",
      ),
    ).toBe(false);
    expect(() =>
      headResult(
        254,
        "An error occurred (403) when calling the HeadObject operation: Forbidden",
        "k",
      ),
    ).toThrow(/can't tell whether k is published/);
    expect(() => headResult(255, "Unable to locate credentials", "k")).toThrow(/can't tell/);
    expect(() => headResult(255, "Could not connect to the endpoint URL", "k")).toThrow(
      /can't tell/,
    );
  });
});

describe("vendor-node", () => {
  it("needs a pinned version in CI and a committed hash for it", () => {
    expect(() => pinnedNode({ CI: "true" })).toThrow(/must be set in CI/);
    expect(pinnedNode({})).toBeNull();
    expect(pinnedNode({ NODE_DIST_VERSION: "24.21.0" }).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => pinnedNode({ NODE_DIST_VERSION: "24.99.0" })).toThrow(/no sha256 is pinned/);
    expect(() => pinnedNode({ NODE_DIST_VERSION: "22.1.0" })).toThrow(/Node 24/);
  });
});

describe("the postPackage hook", () => {
  const signed = {
    ELECTROBUN_BUILD_ENV: "canary",
    ELECTROBUN_DEVELOPER_ID: "Developer ID Application: X",
    ELECTROBUN_OS: "macos",
  };
  it("zips only signed macOS release builds", () => {
    expect(zipPlan({}, [])).toEqual({ skip: "dev build" });
    expect(zipPlan({ ELECTROBUN_BUILD_ENV: "canary" }, [])).toEqual({ skip: "unsigned build" });
    expect(zipPlan(signed, [TAR])).toEqual({
      archive: TAR,
      zip: "canary-macos-arm64-Software-Factory.zip",
      assess: false,
    });
    expect(zipPlan({ ...signed, ELECTROBUN_APPLEAPIKEYPATH: "/k.p8" }, [TAR])).toMatchObject({
      assess: true,
    });
    expect(() => zipPlan(signed, [])).toThrow(/no canary/);
  });
});

describe("the key helper in the release (spec 40 M4b)", () => {
  const TEAM = "ABCDE12345";
  const signed = {
    ELECTROBUN_BUILD_ENV: "canary",
    ELECTROBUN_DEVELOPER_ID: "Developer ID Application: X",
    ELECTROBUN_OS: "macos",
    ELECTROBUN_TEAMID: TEAM,
  };
  const files = [TAR, "canary-macos-arm64-update.json", "canary-macos-arm64-update-v2.json"];

  it("skips cleanly without the helper's profile, and on dev or unsigned builds", () => {
    expect(helperPlan(signed, files, false)).toEqual({
      skip: expect.stringMatching(/MACOS_KEYS_PROFILE/),
    });
    expect(helperPlan({}, files, true)).toEqual({ skip: "dev build" });
    expect(helperPlan({ ELECTROBUN_BUILD_ENV: "canary" }, files, true)).toEqual({
      skip: "unsigned build",
    });
  });

  it("plans the archive, both manifests and notarization", () => {
    expect(helperPlan(signed, files, true)).toEqual({
      archive: TAR,
      manifests: ["canary-macos-arm64-update.json", "canary-macos-arm64-update-v2.json"],
      teamId: TEAM,
      identity: "Developer ID Application: X",
      notarize: null,
    });
    const notarized = {
      ...signed,
      ELECTROBUN_APPLEAPIKEYPATH: "/k.p8",
      ELECTROBUN_APPLEAPIKEY: "KEY",
      ELECTROBUN_APPLEAPIISSUER: "ISS",
    };
    expect(helperPlan(notarized, files, true)).toMatchObject({
      notarize: { key: "/k.p8", keyId: "KEY", issuer: "ISS" },
    });
  });

  it("refuses a half-configured release rather than shipping a broken helper", () => {
    expect(() => helperPlan({ ...signed, ELECTROBUN_TEAMID: "" }, files, true)).toThrow(/Team ID/);
    expect(() => helperPlan(signed, [], true)).toThrow(/no canary/);
    // A delta patch would rebuild Electrobun's archive, without the helper's signature.
    expect(() => helperPlan(signed, [...files, "1abc.patch"], true)).toThrow(/delta patches/);
  });

  it("fills the Team ID into exactly the three entitlements ADR 0394 names", () => {
    const template = readFileSync("native/sf-keys-app/sf-keys.entitlements", "utf8");
    const filled = helperEntitlements(template, TEAM);
    expect(filled).not.toContain("TEAM_ID");
    const keys = [...filled.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual([
      "com.apple.application-identifier",
      "com.apple.developer.team-identifier",
      "keychain-access-groups",
    ]);
    expect(filled).toContain(`<string>${TEAM}.com.software-factory.desktop.keys</string>`);
    expect(() => helperEntitlements("<plist/>", TEAM)).toThrow(/TEAM_ID/);
  });

  it("rewrites the v2 manifest's hash and size and leaves the v1 manifest alone", () => {
    const v2 = JSON.stringify({
      version: "0.1.7",
      hash: "h",
      artifact: { file: TAR, tarSha256: "old", tarSize: 1 },
    });
    expect(JSON.parse(rewriteManifest(v2, "new", 42))).toEqual({
      version: "0.1.7",
      hash: "h",
      artifact: { file: TAR, tarSha256: "new", tarSize: 42 },
    });
    const v1 = JSON.stringify({ version: "0.1.7", artifact: { file: TAR } });
    expect(rewriteManifest(v1, "new", 42)).toBe(v1);
  });

  it("passes the launch smoke test only for a helper that runs and holds its group", () => {
    const group = `${TEAM}.com.software-factory.desktop.keys`;
    const ok = JSON.stringify({
      "com.apple.application-identifier": group,
      "keychain-access-groups": [group],
    });
    expect(smokeVerdict({ status: 0, signal: null, stdout: ok }, TEAM)).toBeNull();
    expect(smokeVerdict({ status: null, signal: "SIGKILL", stdout: "" }, TEAM)).toMatch(/killed/);
    expect(smokeVerdict({ status: 0, signal: null, stdout: "{}" }, TEAM)).toMatch(/access groups/);
    expect(smokeVerdict({ status: 1, signal: null, stdout: ok }, TEAM)).toMatch(/exited 1/);
  });
});
