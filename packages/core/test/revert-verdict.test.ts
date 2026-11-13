// The engine-made revert's verdict and switch (spec 53 §5, decision 2).
import { describe, expect, it } from "vitest";
import { REVERT_AFTER_MS, revertVerdict, revertWithoutPerson } from "../src/index.ts";
import { exactInverse, inert } from "../src/operations/revert.ts";
import { publish } from "../src/stages/types/publish.ts";

const facts = {
  switchOn: true,
  engineRevertOfSuspect: true,
  redForMs: REVERT_AFTER_MS,
  otherRepair: false,
  redOnMain: ["ci"],
  revertCi: new Map([["ci", "success"]]),
  files: [{ path: "src/a.ts", status: "modified" as const }],
};

describe("revertVerdict", () => {
  it("lets the revert merge only when all five conditions hold", () => {
    expect(revertVerdict(facts)).toEqual({ ok: true, reasons: [] });
    expect(revertVerdict({ ...facts, switchOn: false }).reasons).toEqual([
      "the workflow's revertWithoutPerson is off",
    ]);
    expect(revertVerdict({ ...facts, engineRevertOfSuspect: false }).ok).toBe(false);
    expect(revertVerdict({ ...facts, redForMs: REVERT_AFTER_MS - 1 }).ok).toBe(false);
    expect(revertVerdict({ ...facts, otherRepair: true }).ok).toBe(false);
    expect(revertVerdict({ ...facts, revertCi: new Map([["ci", "failure"]]) }).ok).toBe(false);
    expect(revertVerdict({ ...facts, redOnMain: [] }).ok).toBe(false);
    expect(
      revertVerdict({
        ...facts,
        files: [{ path: ".factory/policy.json", status: "modified" as const }],
      }).reasons,
    ).toEqual(["it touches a self-modify path: a person decides"]);
  });

  it("reads the switch from the workflow's Publish stage: off unless a person turned it on", () => {
    const def = (settings: Record<string, unknown>) =>
      ({ stages: [{ id: "merge", type: "publish", settings }] }) as unknown as Parameters<
        typeof revertWithoutPerson
      >[0];
    expect(revertWithoutPerson(def({}))).toBe(false);
    expect(revertWithoutPerson(def({ revertWithoutPerson: true }))).toBe(true);
    expect(publish.settings.parse({}).revertWithoutPerson).toBe(false);
    // Turning it on is a loosening (a person's self-modify save); off again tightens.
    const off = publish.settings.parse({});
    const on = publish.settings.parse({ revertWithoutPerson: true });
    expect(publish.impact?.(off, on, "merge")).toContainEqual(
      expect.objectContaining({ path: "merge.revertWithoutPerson", class: "loosens" }),
    );
    expect(publish.impact?.(on, off, "merge")).toContainEqual(
      expect.objectContaining({ class: "tightens" }),
    );
  });
});

describe("exactInverse", () => {
  const repo = { installationId: "1", owner: "o", repo: "r" };
  // before → merge (changes a.ts); main's base for the PR still has the merge's a.ts.
  const ctx = (trees: Record<string, Record<string, string>>, prPaths: string[]) =>
    ({
      services: {
        github: {
          commitParents: async (_r: unknown, sha: string) => (sha === "merge" ? ["before"] : []),
          compareFiles: async () => [{ path: "a.ts", status: "modified" }],
          changedPaths: async () => ({ mergeBase: "base", paths: prPaths, complete: true }),
          pathEntries: async (_r: unknown, sha: string, paths: string[]) =>
            Object.fromEntries(
              paths
                .filter((p) => trees[sha]?.[p] !== undefined)
                .map((p) => [p, { mode: "100644", sha: trees[sha]?.[p] }]),
            ),
        },
      },
    }) as unknown as Parameters<typeof exactInverse>[0];
  const exact = {
    before: { "a.ts": "old" },
    merge: { "a.ts": "new" },
    base: { "a.ts": "new" },
    revert: { "a.ts": "old" },
  };

  it("holds when the PR's whole diff puts back what was there before the merge, and nothing else", async () => {
    expect(await exactInverse(ctx(exact, ["a.ts"]), repo, "main", "merge", "revert")).toBe(true);
  });

  it("fails on a different result, another path in the PR, or a base main changed since", async () => {
    expect(
      await exactInverse(
        ctx({ ...exact, revert: { "a.ts": "evil" } }, ["a.ts"]),
        repo,
        "main",
        "merge",
        "revert",
      ),
    ).toBe(false);
    expect(await exactInverse(ctx(exact, ["a.ts", "b.ts"]), repo, "main", "merge", "revert")).toBe(
      false,
    );
    expect(
      await exactInverse(
        ctx({ ...exact, base: { "a.ts": "newer" } }, ["a.ts"]),
        repo,
        "main",
        "merge",
        "revert",
      ),
    ).toBe(false);
  });

  it("makes text the App posts inert: no mention, link or closing keyword", () => {
    expect(inert("Fixes #12 for @someone `x`")).toBe("`Fixes #12 for @someone 'x'`");
  });
});
