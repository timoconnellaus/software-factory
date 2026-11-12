import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/index.ts";
import { isTestPath, patchLines, testsIntact } from "../src/verify/tests-intact.ts";

const SHA = "a".repeat(40);
const patch = (...lines: string[]) => ["@@ -10,4 +10,4 @@", ...lines].join("\n");
const mod = (path: string, p: string): ChangedFile => ({ path, status: "modified", patch: p });
const kinds = (files: ChangedFile[]) => testsIntact(SHA, files).findings.map((f) => f.kind);

describe("tests intact (ADR 0450)", () => {
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
    expect(out).toEqual({ headSha: SHA, intact: true, findings: [] });
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
    // Moved to another file: not a removal.
    expect(
      kinds([
        mod("test/a.test.ts", patch('-it("rejects a bad token", () => {')),
        mod("test/b.test.ts", patch('+it("rejects a bad token", () => {')),
      ]),
    ).toEqual([]);
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
    // Ordinary source without a patch isn't the guard's business.
    expect(kinds([{ path: "src/big.ts", status: "modified" }])).toEqual([]);
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
