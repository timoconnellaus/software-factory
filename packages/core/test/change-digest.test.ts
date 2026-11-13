// The change an approval is about (spec 53, ADR 0582), from git trees: identical only when every
// changed file has the same mode and blob on both sides; anything else (and anything unreadable,
// see the deliverer tests) withdraws the approval.
import { describe, expect, it } from "vitest";
import type { CommitInfo, Tree } from "../src/services.ts";
import {
  approvalSurvivesMergeOfMain,
  boundUpdate,
  changeDigest,
  oneSidedMismatches,
  onlyEitherSide,
} from "../src/verify/change-digest.ts";
import fixture from "./fixtures/update-branch-merge.json";

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
      bound: true,
      mergeBaseAmbiguous: false,
      mismatches: [] as string[],
      bothChanged: 0,
      approvedDigest: "d",
      digestNow: "d",
    };
    expect(approvalSurvivesMergeOfMain(ok)).toBe(true);
    expect(approvalSurvivesMergeOfMain({ ...ok, bound: false })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, mergeBaseAmbiguous: true })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, mismatches: null })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, mismatches: ["a"] })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, approvedDigest: null })).toBe(false);
    expect(approvalSurvivesMergeOfMain({ ...ok, digestNow: null })).toBe(false);
    // With nothing changed on both sides, the change must be identical by the strict digest.
    expect(approvalSurvivesMergeOfMain({ ...ok, digestNow: "e" })).toBe(false);
    // A file both sides changed is GitHub's three-way result: a bound update carries it (#61).
    expect(approvalSurvivesMergeOfMain({ ...ok, bothChanged: 1, digestNow: "e" })).toBe(true);
    expect(
      approvalSurvivesMergeOfMain({ ...ok, bothChanged: 1, digestNow: "e", bound: false }),
    ).toBe(false);
  });
});

describe("a merge's one-sided paths (#190 review)", () => {
  const base: Tree = { "a.ts": f("a0"), "b.ts": f("b0"), "c.ts": f("c0"), "both.ts": f("x0") };
  const approved = { ...base, "a.ts": f("a1"), "both.ts": f("x1") };
  const main = { ...base, "b.ts": f("b1"), "both.ts": f("x2") };
  const changed = { ours: new Set(["a.ts", "both.ts"]), theirs: new Set(["b.ts", "both.ts"]) };
  const clean = { ...base, "a.ts": f("a1"), "b.ts": f("b1"), "both.ts": f("x12") };

  it("passes GitHub's clean merge, whatever it made of a file both sides changed", () => {
    expect(oneSidedMismatches({ approved, main, merged: clean }, changed)).toEqual([]);
  });

  it("fails a path the item changed that took main's side (the change undone)", () => {
    const undone = { ...clean, "a.ts": f("a0") };
    expect(oneSidedMismatches({ approved, main, merged: undone }, changed)).toEqual(["a.ts"]);
  });

  it("fails a path main changed that isn't main's, and a path neither changed", () => {
    const edited = { ...clean, "b.ts": f("b9"), "c.ts": f("c9"), "new.ts": f("n") };
    expect(oneSidedMismatches({ approved, main, merged: edited }, changed)).toEqual([
      "b.ts",
      "c.ts",
      "new.ts",
    ]);
  });
});

describe("the update's binding to the factory's call (#190 review)", () => {
  // A real merge GitHub made for the factory App's PUT /pulls/{n}/update-branch, recorded.
  const real = fixture as {
    author: { name: string; email: string };
    committer: { name: string; email: string };
    parents: { sha: string }[];
    verification: { verified: boolean };
  };
  const slug = real.author.name.replace(/\[bot\]$/, "");
  const info: CommitInfo = {
    parents: real.parents.map((p) => p.sha),
    author: { name: real.author.name, email: real.author.email },
    committer: { name: real.committer.name, email: real.committer.email },
    verified: real.verification.verified,
  };
  const [from, base] = info.parents as [string, string];
  const request = { from, base, at: from, appSlug: slug };

  it("binds GitHub's update-branch merge made for the App's own call", () => {
    expect(boundUpdate(info, request)).toBeNull();
  });

  it("refuses a merge made in GitHub's web conflict editor, signed and with the right parents", () => {
    const person = { name: "A Collaborator", email: "1+collab@users.noreply.github.com" };
    expect(boundUpdate({ ...info, author: person }, request)).toMatch(/update-branch merge/);
  });

  it("refuses another App's update, an unsigned commit, and a commit not by GitHub", () => {
    expect(boundUpdate(info, { ...request, appSlug: "another-app" })).not.toBeNull();
    expect(boundUpdate({ ...info, verified: false }, request)).not.toBeNull();
    const pusher = { name: "A Person", email: "person@example.com" };
    expect(boundUpdate({ ...info, committer: pusher }, request)).not.toBeNull();
  });

  it("refuses an older main, a third parent, another head, and a merge nobody asked for", () => {
    expect(boundUpdate(info, { ...request, base: "0".repeat(40) })).toMatch(/default branch/);
    expect(boundUpdate({ ...info, parents: [...info.parents, "c"] }, request)).toMatch(/two/);
    expect(boundUpdate(info, { ...request, from: "f", at: "f" })).toMatch(/approved head/);
    expect(boundUpdate(info, { ...request, from: null })).toMatch(/didn't ask/);
    expect(boundUpdate(info, { ...request, base: null })).toMatch(/didn't ask/);
    expect(boundUpdate(null, request)).not.toBeNull();
  });
});
