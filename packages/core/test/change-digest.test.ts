// The change an approval is about (spec 53, ADR 0582), from git trees: identical only when every
// changed file has the same mode and blob on both sides; anything else (and anything unreadable,
// see the deliverer tests) withdraws the approval.
import { describe, expect, it } from "vitest";
import type { Tree } from "../src/services.ts";
import {
  approvalSurvivesMergeOfMain,
  changeDigest,
  onlyEitherSide,
} from "../src/verify/change-digest.ts";

const f = (sha: string, mode = "100644") => ({ mode, sha });

describe("the change digest", () => {
  const base: Tree = { "src/auth.ts": f("auth0"), "src/api.ts": f("api0"), "README.md": f("r0") };
  const head: Tree = { ...base, "src/api.ts": f("api1"), "src/new.bin": f("bin1") };

  it("is the same when the default branch changed only files the PR didn't", async () => {
    const mainMoved = { ...base, "README.md": f("r1") };
    const merged = { ...head, "README.md": f("r1") };
    expect(await changeDigest(mainMoved, merged)).toBe(await changeDigest(base, head));
  });

  it("differs when a line moves to another place in a file (a different blob)", async () => {
    // Removing requireAdmin() from another function is the same removed line, but a new blob.
    const moved = { ...head, "src/api.ts": f("api1-elsewhere") };
    expect(await changeDigest(base, moved)).not.toBe(await changeDigest(base, head));
  });

  it("differs on a mode change, and hashes binary files by blob", async () => {
    const exec = { ...head, "src/new.bin": f("bin1", "100755") };
    expect(await changeDigest(base, exec)).not.toBe(await changeDigest(base, head));
    const otherBinary = { ...head, "src/new.bin": f("bin2") };
    expect(await changeDigest(base, otherBinary)).not.toBe(await changeDigest(base, head));
  });

  it("differs when both sides changed a file (its base and its head content moved)", async () => {
    const mainMoved = { ...base, "src/api.ts": f("api-main") };
    const merged = { ...head, "src/api.ts": f("api-both") };
    expect(await changeDigest(mainMoved, merged)).not.toBe(await changeDigest(base, head));
  });

  it("finds a third thing in a merge: a file that is neither side's", () => {
    const main = { ...base, "README.md": f("r1") };
    const clean = { ...head, "README.md": f("r1") };
    expect(onlyEitherSide(head, main, clean)).toEqual([]);
    expect(onlyEitherSide(head, main, { ...clean, "src/auth.ts": f("auth-edited") })).toEqual([
      "src/auth.ts",
    ]);
    expect(onlyEitherSide(head, main, { ...clean, "src/extra.ts": f("x") })).toEqual([
      "src/extra.ts",
    ]);
  });

  it("owner question 1: survives only when everything is proven, and fails closed", () => {
    const ok = {
      requestedByFactory: true,
      madeByGitHub: true,
      thirdThings: [] as string[],
      approvedDigest: "d",
      digestNow: "d",
    };
    expect(approvalSurvivesMergeOfMain(ok)).toBe(true);
    expect(approvalSurvivesMergeOfMain({ ...ok, requestedByFactory: false })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, madeByGitHub: false })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, thirdThings: null })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, thirdThings: ["a"] })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, approvedDigest: null })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, digestNow: null })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, digestNow: "e" })).toBe(false);
  });
});
