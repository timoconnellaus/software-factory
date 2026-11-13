// SF Runner.app's sealed scripts load nothing from outside the bundle (spec 45 §1, criterion 2a).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script, without types.
import { SEALED, sealedBuild } from "../scripts/bundle-runner.mjs";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", "sealed", name);
const out = mkdtempSync(join(tmpdir(), "sf-sealed-"));
const problems = async (name: string): Promise<string[]> =>
  (await sealedBuild(fixture(name), "x.cjs", out)).problems;

describe("the sealed build (spec 45 §1)", () => {
  it("passes a script of node: built-ins, written bare or not", async () => {
    expect(await problems("clean.mjs")).toEqual([]);
  });

  it.each([
    ["a bare package import", "bare.mjs", /outside the bundle|Could not resolve/],
    ["createRequire", "create-require.mjs", /createRequire/],
    ["import.meta.resolve", "meta-resolve.mjs", /import\.meta|import_meta/],
    ["a computed require", "computed-require.cjs", /require\(|esbuild/],
  ])("fails on %s", async (_what, name, why) => {
    let found: string[];
    try {
      found = await problems(name);
    } catch (e) {
      found = [String(e)];
    }
    expect(found.join("\n")).toMatch(why);
  });

  it("builds the runner's three scripts self-contained", async () => {
    for (const [name, entry] of Object.entries(SEALED as Record<string, string>))
      expect((await sealedBuild(entry, name, out)).problems, name).toEqual([]);
  });
});
