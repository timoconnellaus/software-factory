// What the factory proved itself (ADR 0501, spec 51): the project's declared checks as the runner
// host ran them on the head SHA, and each acceptance criterion marked Proven only when a check it
// links to passed there (one of the factory's own, or a CI check run). The reviewer agent can link
// a criterion to checks and argue it is met, but its word alone leaves it Not proven.
//
// Pure functions; `reviewPacket.record` reads the results from D1 and CI from GitHub.
import { has } from "../workflow-features.ts";
import type { CiSummary } from "./ci.ts";

/**
 * Whether an item runs the factory's own checks (ADR 0501): its Workflow version has `host-checks`
 * (../workflow-features.ts). The build job carries them, `build #b: checks` reads them, and the
 * verdict uses them. An instance that started earlier keeps the old behaviour throughout (no host
 * checks, the agent's report decides).
 */
export const hostChecksOn = (item: { workflow_version: number | null }) =>
  has(item.workflow_version, "host-checks");

/** One executed check, as stored (core_check_results) for one SHA. */
export interface CheckRun {
  name: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logTail: string;
  round: number;
  /**
   * Why the runner did not run it (no isolation there, no container, the sandbox could not start):
   * never passed, never proven, and never a failure the build is sent back for (third review).
   */
  notRun?: string | null | undefined;
}

export interface CheckOutcome extends CheckRun {
  passed: boolean;
}

/** A declared check: its name, and the command the config declares for it now. */
export interface DeclaredCheck {
  name: string;
  /** When given, a stored result that ran another command is ignored (third review, 5). */
  run?: string | undefined;
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
  /**
   * Declared checks the runner could not run on this SHA, with why: not a failure (a person decides
   * at the merge gate), never passed, never proven.
   */
  notRun: { name: string; reason: string }[];
}

export function executedChecks(
  headSha: string,
  declared: readonly (string | DeclaredCheck)[],
  ran: readonly CheckRun[],
): ExecutedChecks {
  const key = (s: string) => s.toLowerCase();
  const outcome = (r: CheckRun): CheckOutcome => ({
    ...r,
    passed: r.exitCode === 0 && !r.timedOut && !r.notRun,
  });
  const byName = new Map(ran.map((r) => [key(r.name), outcome(r)]));
  const reasons: string[] = [];
  const notRun: { name: string; reason: string }[] = [];
  const decls = declared.map((d) => (typeof d === "string" ? { name: d } : d));
  const results = decls.map(({ name, run }) => {
    let r = byName.get(key(name)) ?? null;
    // A result for another command than the one declared now proves nothing about this one.
    if (r && run !== undefined && r.command.trim() !== run.trim()) {
      reasons.push(
        `check ${name} didn't run on ${headSha.slice(0, 7)} as declared: it ran \`${r.command}\`, the config says \`${run}\``,
      );
      byName.delete(key(name));
      r = null;
      return r;
    }
    if (!r) reasons.push(`check ${name} didn't run on ${headSha.slice(0, 7)}`);
    else if (r.notRun) notRun.push({ name, reason: r.notRun });
    else if (!r.passed) {
      reasons.push(
        `check ${name} failed on ${headSha.slice(0, 7)}: \`${r.command}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode ?? "on a signal"}`}`,
      );
    }
    return r;
  });
  const names = new Set(decls.map((d) => key(d.name)));
  const extra = ran.filter((r) => !names.has(key(r.name))).map(outcome);
  return { declared: decls.map((d) => d.name), results, extra, reasons, notRun };
}

/**
 * What the gate says about checks the runner could not run (third review, B3): one line per reason,
 * "these checks could not be run on this runner: <reason> (<names>)".
 */
export function notRunLines(notRun: ExecutedChecks["notRun"]): string[] {
  const byReason = new Map<string, string[]>();
  for (const n of notRun) byReason.set(n.reason, [...(byReason.get(n.reason) ?? []), n.name]);
  return [...byReason].map(
    ([reason, names]) =>
      `these checks could not be run on this runner: ${reason} (${names.join(", ")}). They are not passed and prove nothing: a person decides.`,
  );
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
   * format), a green CI job the project's config doesn't require, or any check the reviewer linked
   * (only the approved spec's links prove, ADR 0501).
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
  /**
   * The CI checks the project's config requires (`protection.requiredChecks`): only these may prove
   * a criterion, never a CI job the agent added to the PR (third review, 3).
   */
  requiredCi?: readonly string[] | undefined;
  /** The tests-intact guard found gate-file edits on this SHA. */
  gateFilesChanged?: boolean | undefined;
}

/**
 * Marks each criterion Proven or Not proven (ADR 0501, amended 2026-11-12 three times). The criteria
 * are the approved spec's when there is one (a criterion the reviewer left out is Not proven, one it
 * repeated counts once); the reviewer's own, de-duplicated, only where there is no spec. Only links
 * a person approved prove: the approved spec's `[checks: …]` tag on that criterion. A spec link
 * counts when it is one of the factory's checks that passed on the SHA (never one not run), or a
 * green CI check run the project's config requires, and isn't a static check. The reviewer's own
 * links are shown ("linked by the reviewer, not proven") and never prove, whatever passed. Never the
 * reviewer's `met`.
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
  const required = new Set(
    (options.requiredCi ?? []).map(key).filter((n) => n !== "factory/verify"),
  );
  const ciGreen = new Set<string>();
  const ciOther = new Set<string>();
  for (const c of ci.checks) {
    if (c.status !== "completed" || !GREEN_CI.has(c.conclusion ?? "")) continue;
    (required.has(key(c.name)) ? ciGreen : ciOther).add(key(c.name));
  }
  // The reviewer's criteria by their text (without any tag it wrote on them): its first word on each.
  const byText = new Map<string, CriterionInput>();
  for (const c of criteria) {
    const t = norm(specCheckLinks(c.criterion)?.text ?? c.criterion);
    if (!byText.has(t)) byText.set(t, c);
  }
  const spec = (options.specCriteria ?? []).map(
    (c) => specCheckLinks(c) ?? { text: c, checks: null },
  );
  const rows: { criterion: string; specLinks: string[] | null; reviewer: CriterionInput | null }[] =
    [];
  if (spec.length > 0) {
    const seen = new Set<string>();
    for (const s of spec) {
      const t = norm(s.text);
      if (seen.has(t)) continue;
      seen.add(t);
      rows.push({ criterion: s.text, specLinks: s.checks, reviewer: byText.get(t) ?? null });
    }
  } else {
    for (const c of byText.values())
      rows.push({ criterion: c.criterion, specLinks: null, reviewer: c });
  }
  return rows.map(({ criterion, specLinks, reviewer }) => {
    const linkedBy = specLinks ? "spec" : "reviewer";
    const linked = [
      ...new Set((specLinks ?? reviewer?.checks ?? []).map((n) => n.trim()).filter(Boolean)),
    ];
    const provenBy: string[] = [];
    const unproven: string[] = [];
    const notCounted: string[] = [];
    for (const n of linked) {
      const r = factory.get(key(n));
      if (r) {
        if (!r.passed) unproven.push(n);
        else if (linkedBy === "spec" && !isStaticCheck(n, r.command)) provenBy.push(n);
        else notCounted.push(n);
      } else if (ciGreen.has(key(n))) {
        if (linkedBy === "spec" && !isStaticCheck(n)) provenBy.push(n);
        else notCounted.push(n);
      } else if (ciOther.has(key(n))) {
        // Green, but not a check the project requires: any job the PR added could be called this.
        notCounted.push(n);
      } else unproven.push(n);
    }
    return {
      criterion,
      proven: provenBy.length > 0,
      provenBy,
      unproven,
      notCounted,
      linkedBy,
      weakened: provenBy.length > 0 && !!options.gateFilesChanged,
      reviewerMet: reviewer?.met ?? false,
      opinion: reviewer ? reviewer.evidence : "The reviewer did not address this criterion.",
    };
  });
}

/** One line per executed check, for `factory/verify`'s summary. */
export function checkLines(executed: Pick<ExecutedChecks, "declared" | "results">): string[] {
  return executed.declared.map((name, i) => {
    const r = executed.results[i];
    if (!r) return `${name}: didn't run on this commit`;
    if (r.notRun) return `${name}: not run (${r.notRun})`;
    const how = r.timedOut ? "timed out" : `exit ${r.exitCode ?? "signal"}`;
    return `${name}: ${r.passed ? "passed" : "failed"} (\`${r.command}\`, ${how}, ${Math.round(r.durationMs / 1000)} s)`;
  });
}
