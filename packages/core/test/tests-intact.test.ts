import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/index.ts";
import { isTestPath, patchLines, testsIntact } from "../src/verify/tests-intact.ts";

const SHA = "a".repeat(40);
const patch = (...lines: string[]) => ["@@ -10,4 +10,4 @@", ...lines].join("\n");
const mod = (path: string, p: string): ChangedFile => ({ path, status: "modified", patch: p });
const kinds = (files: ChangedFile[]) => testsIntact(SHA, files).findings.map((f) => f.kind);

describe("tests intact (ADR 0500)", () => {
  it("finds nothing when a diff only adds code and tests", () => {
    const out = testsIntact(SHA, [
      {
        path: "src/theme.ts",
        status: "added",
        patch: "@@ -0,0 +1,2 @@\n+export const dark = true;\n+export const light = false;",
      },
      {
        path: "src/theme.test.ts",
        status: "added",
        patch: '@@ -0,0 +1,3 @@\n+it("toggles", () => {\n+  expect(dark).toBe(true);\n+});',
      },
      mod("src/app.ts", patch(" const a = 1;", "-const b = 2;", "+const b = 3;")),
    ]);
    expect(out).toEqual({ headSha: SHA, intact: true, findings: [], total: 0 });
  });

  it("finds a deleted test file, and one renamed out of the tests", () => {
    expect(kinds([{ path: "src/theme.test.ts", status: "removed" }])).toEqual(["test-deleted"]);
    expect(
      kinds([
        {
          path: "src/theme.ts.bak",
          previousPath: "src/theme.test.ts",
          status: "renamed",
          patch: "",
        },
      ]),
    ).toEqual(["test-deleted"]);
  });

  it("finds a removed test case unless its title is added back somewhere", () => {
    const removed = testsIntact(SHA, [
      mod("test/a.test.ts", patch('-it("rejects a bad token", () => {', "-});", " // end")),
    ]);
    expect(removed.findings).toMatchObject([
      { kind: "test-removed", path: "test/a.test.ts", line: 10, message: /rejects a bad token/ },
    ]);
    // Removed and re-added in the same file (an edit): not a removal.
    expect(
      kinds([
        mod(
          "test/a.test.ts",
          patch('-it("rejects a bad token", () => {', '+it("rejects a bad token", async () => {'),
        ),
      ]),
    ).toEqual([]);
    // Titles match per file: the same title added in another file doesn't hide a removal.
    expect(
      kinds([
        mod("test/a.test.ts", patch('-it("rejects a bad token", () => {')),
        mod("test/b.test.ts", patch('+it("rejects a bad token", () => {')),
      ]),
    ).toEqual(["test-removed"]);
    // A title on the next line.
    expect(
      kinds([mod("test/a.test.ts", patch("-it(", '-  "spans two lines",', "-  () => {})"))]),
    ).toEqual(["test-removed"]);
  });

  it("finds skipped, focused, todo and x-prefixed tests", () => {
    for (const line of [
      '+it.skip("a", () => {});',
      '+  test.only("a", () => {});',
      '+it.todo("later");',
      '+describe.skipIf(ci)("a", () => {});',
      '+xit("a", () => {});',
      '+  xdescribe("a", () => {});',
      "+@pytest.mark.skip(reason='flaky')",
    ]) {
      expect(kinds([mod("tests/x.test.ts", patch(line))]), line).toEqual(["test-skipped"]);
    }
    // `fit(` in source code isn't a focused test.
    expect(kinds([mod("src/layout.ts", patch("+fit(box);"))])).toEqual([]);
  });

  it("finds a commented-out test case", () => {
    expect(
      kinds([mod("src/a.test.ts", patch('-it("works", () => {', '+// it("works", () => {'))]),
    ).toEqual(["test-commented-out"]);
  });

  it("finds new suppressions and any casts in code, not in docs", () => {
    for (const line of [
      "+// biome-ignore lint/suspicious/noExplicitAny: x",
      "+// @ts-ignore",
      "+  // @ts-expect-error wrong type",
      "+/* eslint-disable no-console */",
      "+const x = y as any;",
      "+import foo  # type: ignore",
    ]) {
      expect(kinds([mod("src/a.ts", patch(line))]), line).toEqual(["suppression"]);
    }
    expect(kinds([mod("docs/notes.md", patch("+Never use `as any` or @ts-ignore."))])).toEqual([]);
    // A suppression that was already there and is removed is fine.
    expect(kinds([mod("src/a.ts", patch("-// @ts-ignore"))])).toEqual([]);
    expect(
      kinds([mod("packages/x/tsconfig.json", patch('-  "strict": true,', '+  "strict": false,'))]),
    ).toEqual(["suppression"]);
  });

  it("finds a lowered threshold, not a raised one", () => {
    const lowered = testsIntact(SHA, [
      mod(
        "vitest.config.ts",
        patch(
          "-      lines: 90,",
          "-      branches: 80,",
          "+      lines: 70,",
          "+      branches: 85,",
        ),
      ),
    ]);
    expect(lowered.findings.map((f) => f.kind)).toEqual(["gate-file", "threshold-lowered"]);
    expect(lowered.findings[1]?.message).toMatch(/lines.*90 to 70/);
    expect(
      kinds([mod("package.json", patch('-  "minCoverage": 80', '+  "minCoverage": 60'))]),
    ).toEqual(["threshold-lowered"]);
    // A smaller number in ordinary source isn't a threshold.
    expect(
      kinds([mod("src/ui/button.tsx", patch("-  minWidth: 80,", "+  minWidth: 60,"))]),
    ).toEqual([]);
  });

  it("flags edits to gate files, but not a new check under .factory/checks/", () => {
    expect(
      kinds([mod(".github/workflows/ci.yml", patch("-  run: pnpm test", "+  run: true"))]),
    ).toEqual(["gate-file"]);
    expect(kinds([mod(".factory/policy.json", patch('+  "x": 1'))])).toEqual(["gate-file"]);
    expect(kinds([mod("biome.json", patch('+  "x": 1'))])).toEqual(["gate-file"]);
    expect(kinds([mod("apps/app/vitest.config.ts", patch("+  x: 1,"))])).toEqual(["gate-file"]);
    expect(kinds([{ path: ".factory/checks/no-x.json", status: "added" }])).toEqual([]);
  });

  it("reports a test or gate file whose patch GitHub didn't return", () => {
    expect(kinds([{ path: "src/big.test.ts", status: "modified" }])).toEqual(["unreadable"]);
    expect(kinds([{ path: ".github/workflows/ci.yml", status: "modified" }])).toEqual([
      "gate-file",
      "unreadable",
    ]);
    // Code without its patch is unreadable too; an image isn't the guard's business.
    expect(kinds([{ path: "src/big.ts", status: "modified" }])).toEqual(["unreadable"]);
    expect(kinds([{ path: "docs/shot.png", status: "modified" }])).toEqual([]);
  });

  it("reads line numbers from the patch, and knows test paths", () => {
    expect(patchLines("@@ -3,2 +5,3 @@\n a\n-b\n+c\n+d\n\\ No newline at end of file")).toEqual([
      { sign: "-", text: "b", line: 4 },
      { sign: "+", text: "c", line: 6 },
      { sign: "+", text: "d", line: 7 },
    ]);
    for (const p of [
      "src/a.test.ts",
      "x/__tests__/a.ts",
      "test/helpers.ts",
      "a.spec.tsx",
      "tests/test_a.py",
    ]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["src/testing.ts", "src/contest.ts", "docs/test-plan.md"]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe("tests intact: review fixes (ADR 0500)", () => {
  const many = (n: number): ChangedFile[] =>
    Array.from({ length: n }, (_, i) => ({ path: `docs/n${i}.md`, status: "added", patch: "+x" }));

  it("never reads a truncated or empty compare as intact", () => {
    expect(kinds(many(299))).toEqual([]);
    expect(testsIntact(SHA, many(300)).findings).toMatchObject([
      { kind: "unreadable", message: /300 files/ },
    ]);
    expect(kinds([])).toEqual(["unreadable"]);
  });

  it("finds gate changes that stop tests running without touching a listed file", () => {
    expect(
      kinds([mod("package.json", patch('-    "test": "vitest run",', '+    "test": "true",'))]),
    ).toEqual(["gate-file"]);
    expect(kinds([mod("package.json", patch('+    "vitest": { "exclude": ["**"] },'))])).toEqual([
      "gate-file",
    ]);
    // A dependency bump isn't a gate change.
    expect(
      kinds([mod("package.json", patch('-    "zod": "4.1.0",', '+    "zod": "4.2.0",'))]),
    ).toEqual([]);
    expect(kinds([mod("tsconfig.json", patch('+  "exclude": ["src/legacy"],'))])).toEqual([
      "gate-file",
    ]);
    for (const p of [
      ".github/actions/setup/action.yml",
      "vitest.shared.ts",
      "apps/x/vitest.e2e.config.ts",
      "jest.setup.js",
      ".eslintignore",
    ]) {
      expect(kinds([mod(p, patch("+x"))]), p).toContain("gate-file");
    }
  });

  it("finds a test moved where the run won't pick it up; a plain rename between test paths is clean", () => {
    const move = (from: string, to: string): ChangedFile => ({
      path: to,
      previousPath: from,
      status: "renamed",
      changes: 0,
    });
    expect(kinds([move("test/a.test.ts", "test/disabled/a.test.ts")])).toEqual(["test-deleted"]);
    expect(kinds([move("src/a.test.ts", "spikes/a.test.ts")])).toEqual(["test-deleted"]);
    expect(kinds([move("src/a.test.ts", "src/theme/a.test.ts")])).toEqual([]);
  });

  it("keeps the total when it cuts the findings to 100", () => {
    const lines = Array.from({ length: 150 }, () => "+// @ts-ignore").join("\n");
    const out = testsIntact(SHA, [mod("src/a.ts", `@@ -1,1 +1,150 @@\n${lines}`)]);
    expect([out.findings.length, out.total]).toEqual([100, 150]);
  });

  it("finds the skips the first pattern missed", () => {
    for (const line of [
      '+test.fails("a", () => {});',
      '+it.concurrent.skip("a", () => {});',
      '+it.each([1, 2])("a %d", () => {}).skip',
      "+describe.each`a`.only",
      '+describe.skipIf(process.env.CI)("a", () => {});',
      "+  ctx.skip();",
      "+    this.skip();",
    ]) {
      expect(kinds([mod("tests/x.test.ts", patch(line))]), line).toEqual(["test-skipped"]);
    }
    expect(kinds([mod("tests/x.test.ts", patch("+/*", '+it("a", () => {});', "+*/"))])).toEqual([
      "test-commented-out",
      "test-commented-out",
    ]);
  });

  it("only treats coverage keys as thresholds, not every min*", () => {
    expect(
      kinds([mod("vitest.config.ts", patch("-  minutes: 30,", "+  minutes: 5,"))]).filter(
        (k) => k !== "gate-file",
      ),
    ).toEqual([]);
    expect(
      kinds([mod("jest.config.js", patch("-  minCoverage: 90,", "+  minCoverage: 50,"))]),
    ).toEqual(["gate-file", "threshold-lowered"]);
  });
});
