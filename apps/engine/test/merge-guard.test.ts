// #190 review, round 2: nothing merges a pull request on a head the factory hasn't verified itself.
// Every call of the GitHub adapter's merge (`mergePullRequest`) is inside an operation in the
// registry, and that operation calls `requireVerifiedHead` before it (a pass packet and the
// factory's own factory/verify success for that exact SHA). A new call site fails here until it is.
import { operations } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { github, world } from "./helpers.ts";

const sources = {
  ...import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../packages/core/src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

const strip = (text: string) => text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Where the adapter's merge is defined or faked, not called: its client, the fake, the contract. */
const DEFINES = [
  "../src/github/app.ts",
  "../src/deps.ts",
  "../../../packages/core/src/services.ts",
  "../../../packages/core/src/testing/fake-github.ts",
];

/** Each call site: the file, and the operation (`defineOperation({ name })`) it is inside. */
function callSites(method = "mergePullRequest") {
  const sites: { file: string; op: string | null; before: string }[] = [];
  for (const [file, raw] of Object.entries(sources)) {
    if (DEFINES.includes(file)) continue;
    const text = strip(raw);
    for (const m of text.matchAll(new RegExp(`\\.${method}\\(`, "g"))) {
      const at = m.index ?? 0;
      const start = text.lastIndexOf("defineOperation(", at);
      const name = start >= 0 ? /name:\s*"([^"]+)"/.exec(text.slice(start, at))?.[1] : undefined;
      sites.push({ file, op: name ?? null, before: start >= 0 ? text.slice(start, at) : "" });
    }
  }
  return sites;
}

describe("every merge goes through requireVerifiedHead", () => {
  it("reads the sources (core and engine)", () => {
    expect(Object.keys(sources).some((f) => f.endsWith("operations/github.ts"))).toBe(true);
    expect(Object.keys(sources).some((f) => f.endsWith("deliver/deliverer.ts"))).toBe(true);
  });

  it("finds each call of the adapter's merge inside a registered operation that checks the head first", () => {
    const sites = callSites();
    expect(sites.length).toBeGreaterThanOrEqual(2);
    const registered = new Set(
      Object.values(operations as Record<string, unknown>).flatMap((o) =>
        typeof o === "object" && o !== null && "handler" in o && "name" in o
          ? [String((o as { name: unknown }).name)]
          : [],
      ),
    );
    for (const s of sites) {
      expect(s.op, `${s.file}: a merge outside an operation`).not.toBeNull();
      expect(registered.has(String(s.op)), `${s.op} isn't a registered operation`).toBe(true);
      expect(s.before, `${s.op} merges without requireVerifiedHead`).toMatch(
        /requireVerifiedHead\(/,
      );
    }
    expect(sites.map((s) => s.op).sort()).toEqual(["pr.autoMerge", "pr.merge"]);
  });

  // Round 3: enforced by types too. The adapter's merge takes a VerifiedHead, and only
  // requireVerifiedHead makes one: no other cast to it in src.
  it("makes a VerifiedHead only in requireVerifiedHead", () => {
    const casts = Object.entries(sources).flatMap(([file, raw]) =>
      [...strip(raw).matchAll(/as VerifiedHead\b/g)].map(() => file),
    );
    expect(casts).toEqual(["../../../packages/core/src/operations/merge-queue.ts"]);
  });

  // The queue's own merge of main into a PR's branch (#190 review, round 3): only mergeQueue.update
  // calls it, and the adapter itself refuses the default branch as the target.
  it("merges main into a branch only from mergeQueue.update, never into the default branch", async () => {
    expect(callSites("mergeIntoBranch").map((s) => s.op)).toEqual(["mergeQueue.update"]);
    const w = await world();
    const before = (await github.state(w.repo)).refs.main;
    expect(
      await github.mergeIntoBranch(w.repo, { branch: "main", head: "main", message: "" }),
    ).toMatchObject({ status: "refused" });
    expect((await github.state(w.repo)).refs.main).toBe(before);
  });
});
