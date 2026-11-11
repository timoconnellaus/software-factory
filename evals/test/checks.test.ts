import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryCheckSchema, globToRegExp, PACKAGE, runCheck } from "../src/index.ts";
import { loadChecks, loadRegressions } from "../src/load.ts";
import { ROOT_CAUSES, runRegression } from "../src/regressions.ts";

const here = import.meta.dirname;

describe(".factory/checks", () => {
  it("exports its package name", () => {
    expect(PACKAGE).toBe("@software-factory/evals");
  });

  it("matches globs by path segment", () => {
    expect(globToRegExp("apps/**/src/**/*.ts").test("apps/engine/src/workflow/x.ts")).toBe(true);
    expect(globToRegExp("apps/**/src/**/*.ts").test("apps/engine/src/x.ts")).toBe(true);
    expect(globToRegExp("apps/**/src/**/*.ts").test("apps/engine/test/x.ts")).toBe(false);
    expect(globToRegExp("*.json").test("a/b.json")).toBe(false);
    expect(globToRegExp("**/*.json").test("b.json")).toBe(true);
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
  });

  it("flags forbidden and missing patterns only in the files it applies to", () => {
    const check = factoryCheckSchema.parse({
      name: "migrations-header",
      description: "Every migration starts with a comment saying what it does.",
      appliesTo: ["packages/db/migrations/*.sql"],
      require: ["^-- Migration \\d{4}"],
      forbid: ["DROP TABLE"],
      message: "Start migrations with a header; never drop tables.",
    });
    const bad = runCheck(check, [
      { path: "packages/db/migrations/0050_x.sql", content: "DROP TABLE core_x;" },
      {
        path: "packages/db/migrations/0051_y.sql",
        content: "-- Migration 0051: y\nCREATE TABLE y (id);",
      },
      { path: "src/other.sql", content: "DROP TABLE z;" },
    ]);
    expect(bad.map((v) => `${v.path}:${v.rule}`)).toEqual([
      "packages/db/migrations/0050_x.sql:forbid",
      "packages/db/migrations/0050_x.sql:require",
    ]);
  });

  it("rejects a check with nothing to check or unknown keys", () => {
    const base = { name: "x", description: "d", appliesTo: ["*"], message: "m" };
    expect(factoryCheckSchema.safeParse(base).success).toBe(false);
    expect(factoryCheckSchema.safeParse({ ...base, forbid: ["a"], extra: 1 }).success).toBe(false);
  });
});

describe("regression cases", () => {
  it("runs the example: the check fails the input that slipped through and passes the good ones", () => {
    const checks = loadChecks(join(here, "../fixtures/checks"));
    const [example] = loadRegressions(join(here, "../fixtures/regressions"));
    expect(example && runRegression(example, checks)).toEqual({
      incident: "example-console-log",
      ok: true,
      problems: [],
    });
  });

  it("fails a case whose check doesn't catch it, or names no check", () => {
    const checks = loadChecks(join(here, "../fixtures/checks"));
    const [example] = loadRegressions(join(here, "../fixtures/regressions"));
    if (!example) throw new Error("no example");
    const missed = runRegression(
      { ...example, cases: [{ path: "apps/x/src/a.ts", content: "log('x')", expect: "fail" }] },
      checks,
    );
    expect(missed.ok).toBe(false);
    expect(runRegression({ ...example, check: "nope" }, checks).problems).toEqual([
      "no check named nope",
    ]);
  });

  it("uses the same root-cause classes as the core's incident classifier", () => {
    const core = readFileSync(join(here, "../../packages/core/src/incidents/classify.ts"), "utf8");
    const block = core.slice(core.indexOf("export const ROOT_CAUSES"), core.indexOf("] as const"));
    const names = [...block.matchAll(/^\s*"([a-z-]+)",/gm)].map((m) => m[1]);
    expect(names).toEqual([...ROOT_CAUSES]);
  });
});
