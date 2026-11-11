// `evals/regressions/<incident>.json`: one regression case per factory incident (V1 improvement
// loop). It records the input that slipped through and what the incident's new check must now say
// about it, plus inputs that must still pass, so the check can't be "fixed" by flagging everything.
import { z } from "zod";
import { type FactoryCheck, runCheck } from "./checks.ts";

export const ROOT_CAUSES = [
  "missing-check",
  "prompt-or-skill",
  "missing-context",
  "policy",
  "runner",
  "confinement",
  "unknown",
] as const;

export const regressionCaseSchema = z
  .object({
    /** The incident id (`inc_…`); the file is `evals/regressions/<id>.json`. */
    incident: z.string().regex(/^inc_[0-9a-f]{32}$|^example-[a-z0-9-]+$/),
    rootCause: z.enum(ROOT_CAUSES),
    /** What went wrong, in a sentence. */
    summary: z.string().min(1).max(2_000),
    /** The `.factory/checks/` check that catches it. */
    check: z.string().min(1),
    cases: z
      .array(
        z.object({
          path: z.string().min(1),
          content: z.string(),
          expect: z.enum(["fail", "pass"]),
        }),
      )
      .min(1)
      .refine((cases) => cases.some((c) => c.expect === "fail"), "needs a case that must fail"),
  })
  .strict();
export type RegressionCase = z.infer<typeof regressionCaseSchema>;

export interface RegressionResult {
  incident: string;
  ok: boolean;
  problems: string[];
}

/** Runs one regression case against the checks it names. */
export function runRegression(
  rc: RegressionCase,
  checks: ReadonlyMap<string, FactoryCheck>,
): RegressionResult {
  const check = checks.get(rc.check);
  if (!check) return { incident: rc.incident, ok: false, problems: [`no check named ${rc.check}`] };
  const problems: string[] = [];
  for (const c of rc.cases) {
    const flagged = runCheck(check, [{ path: c.path, content: c.content }]).length > 0;
    if (c.expect === "fail" && !flagged)
      problems.push(`${check.name} passes ${c.path}, but must fail it`);
    if (c.expect === "pass" && flagged)
      problems.push(`${check.name} fails ${c.path}, but must pass it`);
  }
  return { incident: rc.incident, ok: problems.length === 0, problems };
}
