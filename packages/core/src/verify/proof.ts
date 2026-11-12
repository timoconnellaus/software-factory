// What the factory proved itself (ADR 0451, spec 51): the project's declared checks as the runner
// host ran them on the head SHA, and each acceptance criterion marked Proven only when a check it
// links to passed there (one of the factory's own, or a CI check run). The reviewer agent can link
// a criterion to checks and argue it is met, but its word alone leaves it Not proven.
//
// Pure functions; `reviewPacket.record` reads the results from D1 and CI from GitHub.
import type { CiSummary } from "./ci.ts";

/** One executed check, as stored (core_check_results) for one SHA. */
export interface CheckRun {
  name: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logTail: string;
  round: number;
}

export interface CheckOutcome extends CheckRun {
  passed: boolean;
}

/** The declared checks against what ran on the SHA. */
export interface ExecutedChecks {
  /** What the project's config declares for this item, by name. */
  declared: string[];
  /** Each declared check's result on the SHA, or null when it didn't run there. */
  results: (CheckOutcome | null)[];
  /** Results for checks no longer declared (kept, shown, not counted). */
  extra: CheckOutcome[];
  /** Why the executed checks fail the verdict, one line each. */
  reasons: string[];
}

export function executedChecks(
  headSha: string,
  declared: readonly string[],
  ran: readonly CheckRun[],
): ExecutedChecks {
  const key = (s: string) => s.toLowerCase();
  const outcome = (r: CheckRun): CheckOutcome => ({
    ...r,
    passed: r.exitCode === 0 && !r.timedOut,
  });
  const byName = new Map(ran.map((r) => [key(r.name), outcome(r)]));
  const reasons: string[] = [];
  const results = declared.map((name) => {
    const r = byName.get(key(name)) ?? null;
    if (!r) reasons.push(`check ${name} didn't run on ${headSha.slice(0, 7)}`);
    else if (!r.passed) {
      reasons.push(
        `check ${name} failed on ${headSha.slice(0, 7)}: \`${r.command}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode ?? "on a signal"}`}`,
      );
    }
    return r;
  });
  const names = new Set(declared.map(key));
  const extra = ran.filter((r) => !names.has(key(r.name))).map(outcome);
  return { declared: [...declared], results, extra, reasons };
}

export interface CriterionInput {
  criterion: string;
  met: boolean;
  evidence: string;
  /** Check names the reviewer linked it to. */
  checks?: string[] | undefined;
}

export interface CriterionProof {
  criterion: string;
  proven: boolean;
  /** The linked checks that passed on the SHA: what proves it. */
  provenBy: string[];
  /** Linked names that didn't pass or don't exist on the SHA. */
  unproven: string[];
  /** The reviewer's judgement and words: opinion, shown as such. */
  reviewerMet: boolean;
  opinion: string;
}

const GREEN_CI = new Set(["success"]);

/**
 * Marks each criterion Proven or Not proven. A linked name counts when it is one of the factory's
 * checks that passed on the SHA, or a CI check run there that succeeded. Never the reviewer's `met`.
 */
export function proveCriteria(
  criteria: readonly CriterionInput[],
  executed: ExecutedChecks,
  ci: Pick<CiSummary, "checks">,
): CriterionProof[] {
  const key = (s: string) => s.trim().toLowerCase();
  const passed = new Set<string>();
  for (const r of [...executed.results, ...executed.extra]) {
    if (r?.passed) passed.add(key(r.name));
  }
  for (const c of ci.checks) {
    if (c.status === "completed" && GREEN_CI.has(c.conclusion ?? "")) passed.add(key(c.name));
  }
  return criteria.map((c) => {
    const linked = [...new Set((c.checks ?? []).map((n) => n.trim()).filter(Boolean))];
    const provenBy = linked.filter((n) => passed.has(key(n)));
    return {
      criterion: c.criterion,
      proven: provenBy.length > 0,
      provenBy,
      unproven: linked.filter((n) => !passed.has(key(n))),
      reviewerMet: c.met,
      opinion: c.evidence,
    };
  });
}

/** One line per executed check, for `factory/verify`'s summary. */
export function checkLines(executed: Pick<ExecutedChecks, "declared" | "results">): string[] {
  return executed.declared.map((name, i) => {
    const r = executed.results[i];
    if (!r) return `${name}: didn't run on this commit`;
    const how = r.timedOut ? "timed out" : `exit ${r.exitCode ?? "signal"}`;
    return `${name}: ${r.passed ? "passed" : "failed"} (\`${r.command}\`, ${how}, ${Math.round(r.durationMs / 1000)} s)`;
  });
}
