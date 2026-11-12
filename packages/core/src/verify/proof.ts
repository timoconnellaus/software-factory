// What the factory proved itself (ADR 0501, spec 51): the project's declared checks as the runner
// host ran them on the head SHA, and each acceptance criterion marked Proven only when a check it
// links to passed there (one of the factory's own, or a CI check run). The reviewer agent can link
// a criterion to checks and argue it is met, but its word alone leaves it Not proven.
//
// Pure functions; `reviewPacket.record` reads the results from D1 and CI from GitHub.
import type { CiSummary } from "./ci.ts";

/**
 * The Workflow version from which an item runs the factory's own checks (ADR 0501): the build job
 * carries them, `build #b: checks` reads them, and the verdict uses them. An instance that started
 * earlier keeps the old behaviour throughout (no host checks, the agent's report decides).
 */
export const HOST_CHECKS_WORKFLOW_VERSION = 8;

export const hostChecksOn = (item: { workflow_version: number | null }) =>
  (item.workflow_version ?? 0) >= HOST_CHECKS_WORKFLOW_VERSION;

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
  /** The linked checks that passed on the SHA and count as proof. */
  provenBy: string[];
  /** Linked names that didn't pass or don't exist on the SHA. */
  unproven: string[];
  /**
   * Linked names that passed but can't prove a criterion: a static check (lint, typecheck,
   * format), or a CI check run the reviewer chose (only the approved spec may name CI).
   */
  notCounted: string[];
  /** Who linked the checks: the human-approved spec, or the reviewer agent (ADR 0501). */
  linkedBy: "spec" | "reviewer";
  /**
   * The tests-intact guard (ADR 0500) found gate-file edits on this SHA: what the checks run, or
   * how, changed, so a pass proves less. Shown as weakened, never hidden.
   */
  weakened: boolean;
  /** The reviewer's judgement and words: opinion, shown as such. */
  reviewerMet: boolean;
  opinion: string;
}

const GREEN_CI = new Set(["success"]);

/**
 * Checks that only read the code (lint, typecheck, format): they never prove a behavioural
 * criterion, whoever links them.
 */
const STATIC_CHECK =
  /\b(lint|linter|eslint|biome|prettier|stylelint|format|fmt|typecheck|type-check|types|tsc|knip|spell(ing|check)?)\b/i;

export function isStaticCheck(name: string, command = ""): boolean {
  return (
    STATIC_CHECK.test(name) ||
    STATIC_CHECK.test(command.replace(/^\s*(pnpm|npm|yarn|bun)\s+(run\s+)?/, ""))
  );
}

/**
 * The criterion-to-check links an approved spec carries: a criterion that ends with
 * `[checks: tests, e2e]` (a person approved that). Returns the criterion without the tag, and the
 * names; no tag: null.
 */
export function specCheckLinks(criterion: string): { text: string; checks: string[] } | null {
  const m = /\s*\[(?:checks?|proven by)\s*:\s*([^\]]*)\]\s*$/i.exec(criterion);
  if (!m) return null;
  return {
    text: criterion.slice(0, m.index).trim(),
    checks: (m[1] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

export interface ProofOptions {
  /** The approved spec's acceptance criteria (with any `[checks: …]` tags), when there is one. */
  specCriteria?: readonly string[] | null | undefined;
  /** The tests-intact guard found gate-file edits on this SHA. */
  gateFilesChanged?: boolean | undefined;
}

/**
 * Marks each criterion Proven or Not proven (ADR 0501, amended 2026-11-12). The links come from the
 * approved spec when it tags the criterion, else from the reviewer (labelled as such). A linked name
 * counts when it is one of the factory's checks that passed on the SHA and isn't a static check;
 * a CI check run counts only when the spec names it. Never the reviewer's `met`.
 */
export function proveCriteria(
  criteria: readonly CriterionInput[],
  executed: ExecutedChecks,
  ci: Pick<CiSummary, "checks">,
  options: ProofOptions = {},
): CriterionProof[] {
  const key = (s: string) => s.trim().toLowerCase();
  const norm = (s: string) =>
    key(s)
      .replace(/\s+/g, " ")
      .replace(/[.;:]$/, "");
  const factory = new Map<string, CheckOutcome>();
  for (const r of [...executed.results, ...executed.extra]) if (r) factory.set(key(r.name), r);
  const ciGreen = new Set<string>();
  for (const c of ci.checks) {
    if (c.status === "completed" && GREEN_CI.has(c.conclusion ?? "")) ciGreen.add(key(c.name));
  }
  const spec = (options.specCriteria ?? []).map(
    (c) => specCheckLinks(c) ?? { text: c, checks: null },
  );
  const fromSpec = (criterion: string, i: number): string[] | null => {
    const own = specCheckLinks(criterion);
    const text = norm(own?.text ?? criterion);
    const match =
      spec.find((s) => norm(s.text) === text) ??
      (spec.length === criteria.length ? spec[i] : undefined);
    return match?.checks ?? null;
  };
  return criteria.map((c, i) => {
    const specLinks = fromSpec(c.criterion, i);
    const linkedBy = specLinks ? "spec" : "reviewer";
    const linked = [...new Set((specLinks ?? c.checks ?? []).map((n) => n.trim()).filter(Boolean))];
    const provenBy: string[] = [];
    const unproven: string[] = [];
    const notCounted: string[] = [];
    for (const n of linked) {
      const r = factory.get(key(n));
      if (r?.passed) {
        if (isStaticCheck(r.name, r.command)) notCounted.push(n);
        else provenBy.push(n);
      } else if (!r && ciGreen.has(key(n))) {
        if (linkedBy === "spec" && !isStaticCheck(n)) provenBy.push(n);
        else notCounted.push(n);
      } else unproven.push(n);
    }
    return {
      criterion: c.criterion,
      proven: provenBy.length > 0,
      provenBy,
      unproven,
      notCounted,
      linkedBy,
      weakened: provenBy.length > 0 && !!options.gateFilesChanged,
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
