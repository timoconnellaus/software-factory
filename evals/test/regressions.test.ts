// The regression eval CI runs on every PR (ADR 0230): every check in the repo's `.factory/checks/`
// passes over the repo, and every case in `evals/regressions/` gets the answer it expects. An
// incident's fix PR goes green only when its new check catches the case that slipped through.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "../src/checks.ts";
import { loadChecks, loadRegressions, repoFiles } from "../src/load.ts";
import { runRegression } from "../src/regressions.ts";

const root = join(import.meta.dirname, "../..");
const checks = loadChecks(join(root, ".factory/checks"));
const cases = loadRegressions(join(root, "evals/regressions"));

describe("the repo's own checks and regression cases", () => {
  it("passes every .factory/checks/ check over the repo", () => {
    if (checks.size === 0) return;
    const files = repoFiles(root);
    const violations = [...checks.values()].flatMap((c) => runCheck(c, files));
    expect(
      violations.map((v) => `${v.check}: ${v.path} (${v.rule} ${v.pattern}): ${v.message}`),
    ).toEqual([]);
  });

  it("gets every regression case right", () => {
    const failed = cases.map((rc) => runRegression(rc, checks)).filter((r) => !r.ok);
    expect(failed).toEqual([]);
  });
});
