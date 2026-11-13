import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseEntry, cliArgsAllowed, ENTRIES } from "../src/launcher-entries.ts";

const cases = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "launcher-entry-cases.json"), "utf8"),
) as { cases: { args: string[]; run: (string | null)[] | null }[] };

describe("launcher entries (spec 45 §1)", () => {
  it("agrees with the launcher on every shared case", () => {
    expect(cases.cases.length).toBeGreaterThan(20);
    for (const c of cases.cases) {
      const got = chooseEntry(c.args);
      if (c.run === null) {
        expect(got, JSON.stringify(c.args)).toBeNull();
      } else {
        expect(got, JSON.stringify(c.args)).not.toBeNull();
        expect(
          [got?.entry.script ?? null, ...(got?.scriptArgs ?? [])],
          JSON.stringify(c.args),
        ).toEqual(c.run);
      }
    }
  });

  it("refuses an argument over 2 KiB", () => {
    expect(chooseEntry(["login", "--url", `https://e.example.com/${"a".repeat(2100)}`])).toBeNull();
  });

  it("names every script plainly, as CommonJS", () => {
    for (const entry of Object.values(ENTRIES))
      if (entry.script) expect(entry.script).toMatch(/^[a-z-]+\.cjs$/);
  });

  it("under the service, the CLI takes only what an entry hands it", () => {
    const svc = { SF_RUNNER_SERVICE: "1" };
    expect(cliArgsAllowed("sf-runner.cjs", ["run"], svc)).toBe(true);
    expect(cliArgsAllowed("sf-runner.cjs", ["login", "--no-install", "--name", "m5"], svc)).toBe(
      true,
    );
    expect(cliArgsAllowed("sf-runner.cjs", ["login", "--name", "m5"], svc)).toBe(false);
    expect(cliArgsAllowed("sf-runner.cjs", ["service", "stop", "--when", "idle"], svc)).toBe(true);
    expect(cliArgsAllowed("sf-runner.cjs", ["install"], svc)).toBe(false);
    expect(
      cliArgsAllowed("sf-runner.cjs", ["pair", "--runner-id", "r_1", "--key-stdin"], svc),
    ).toBe(false);
    expect(cliArgsAllowed("service.cjs", ["--selftest"], svc)).toBe(true);
    expect(cliArgsAllowed("service.cjs", [], svc)).toBe(true);
    expect(cliArgsAllowed("service.cjs", ["--inspect"], svc)).toBe(false);
    expect(cliArgsAllowed("sf-runner.cjs", ["install"], {})).toBe(true);
  });
});
