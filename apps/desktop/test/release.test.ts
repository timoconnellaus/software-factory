// The release scripts (spec 40 M4): what CI uploads, in what order, and what it refuses.
import { describe, expect, it } from "vitest";
import { zipPlan } from "../scripts/hook-post-package.ts";
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
