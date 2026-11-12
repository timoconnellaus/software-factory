// The change an approval is about (spec 53, ADR 0582): unchanged by a clean merge of the default
// branch (which moves hunks and context), changed by anything that adds or removes other lines.
import { describe, expect, it } from "vitest";
import { changeDigest } from "../src/verify/change-digest.ts";

const file = (patch: string | undefined, path = "src/a.ts") => ({
  path,
  status: "modified" as const,
  ...(patch === undefined ? {} : { patch }),
});

describe("the change digest", () => {
  it("ignores hunk positions and context lines, and file order", async () => {
    const before = await changeDigest([
      file("@@ -1,3 +1,4 @@\n ctx one\n+added\n-removed\n ctx two"),
      file("@@ -9 +9 @@\n+b", "src/b.ts"),
    ]);
    const after = await changeDigest([
      file("@@ -40 +41 @@\n+b", "src/b.ts"),
      file("@@ -20,3 +21,4 @@\n other context\n+added\n-removed\n moved"),
    ]);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(after).toBe(before);
  });

  it("changes when a line added or removed changes, or a file joins", async () => {
    const base = await changeDigest([file("@@ -1 +1 @@\n+added")]);
    expect(await changeDigest([file("@@ -1 +1 @@\n+added too")])).not.toBe(base);
    expect(
      await changeDigest([file("@@ -1 +1 @@\n+added"), file("@@ -1 +1 @@\n+x", "src/c.ts")]),
    ).not.toBe(base);
  });

  it("can't be read when GitHub left a patch out", async () => {
    expect(await changeDigest([file(undefined)])).toBeNull();
    // A pure rename has no lines to compare and still has a digest.
    expect(
      await changeDigest([
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", changes: 0 },
      ]),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
