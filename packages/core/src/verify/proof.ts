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
  /** Where it ran (fourth review): `weaker-sandbox` is named at the gate. */
  isolation?: string | null | undefined;
}

export interface CheckOutcome extends CheckRun {
  passed: boolean;
}

/** A declared check: its name, and the command the config declares for it now. */
export interface DeclaredCheck {
  name: string;
  /** When given, a stored result that ran another command is ignored (third review, 5). */
  run?: string | undefined;
  /** Whether a pass can prove a criterion (`checkProves`); omitted: decided by name and command. */
  proves?: boolean | undefined;
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
  /**
   * Declared checks that ran in the weaker sandbox of a Mac runner whose owner opted in (fourth
   * review): a process such a check leaves can outlive it. Said at the gate, never hidden.
   */
  weaker: string[];
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
  const weaker = results
    .filter((r): r is CheckOutcome => !!r && !r.notRun && r.isolation === "weaker-sandbox")
    .map((r) => r.name);
  return { declared: decls.map((d) => d.name), results, extra, reasons, notRun, weaker };
}

/**
 * `factory/verify`'s title when declared checks could not be run (fourth review, S2): "N declared
 * checks could not be run on this runner: <reason>".
 */
export function notRunTitle(notRun: ExecutedChecks["notRun"]): string {
  const reasons = [...new Set(notRun.map((n) => n.reason))];
  const n = notRun.length;
  const title = `${n} declared check${n === 1 ? "" : "s"} could not be run on this runner: ${reasons.join("; ")}`;
  // A check run's title is short on GitHub; the summary says the rest.
  return title.length > 200 ? `${title.slice(0, 199)}…` : title;
}

/** The gate's line for checks that ran in the weaker sandbox (fourth review). */
export function weakerLines(weaker: readonly string[]): string[] {
  return weaker.length
    ? [
        `these checks ran in the weaker sandbox of a Mac runner whose owner opted in (${weaker.join(", ")}): a process a check leaves can outlive it (ADR 0501)`,
      ]
    : [];
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
  /**
   * Proven: a check a person tied it to (the approved spec) passed on the SHA. Only this counts as
   * proven anywhere: the gate's count, `factory/verify` and auto-approval (ADR 0515).
   */
  proven: boolean;
  /** The linked checks that passed on the SHA and count as proof. */
  provenBy: string[];
  /**
   * The checks triage (an agent) tied it to that passed on the SHA: "Passed `tests`, the check
   * triage named (not checked by a person)". Never Proven, and counted apart (amended 2026-11-13):
   * triage tying every criterion to the whole suite would otherwise prove each one.
   */
  passedTriageCheck?: string[];
  /** The criterion comes from triage's list (an item without a spec), not a person-approved spec. */
  fromTriage?: boolean;
  /** Linked names that didn't pass or don't exist on the SHA. */
  unproven: string[];
  /**
   * Linked names that passed but can't prove a criterion: a static check (lint, typecheck,
   * format), a green CI job the project's config doesn't require, or any check the reviewer linked
   * (only the approved spec's links prove, ADR 0501).
   */
  notCounted: string[];
  /**
   * Who linked the checks: the human-approved spec, triage's validated ties for an item without a
   * spec (the Workflow's `triage-ties` feature, recorded before any check ran), or the reviewer agent (ADR 0501).
   */
  linkedBy: "spec" | "triage" | "reviewer";
  /**
   * The spec or triage said no declared check can prove this criterion (`[checks: none]`): an
   * honest answer, shown as "not covered by a check", never forced onto a check.
   */
  uncovered?: boolean;
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

/** Checks that set up the tree (install, build): a pass says the code installs, not that it works. */
const SETUP_CHECK =
  /\b(install|build|compile|bundle|setup|bootstrap|deps|dependencies|prepare|codegen|generate)\b/i;
/** A package manager's install (`pnpm install`, `npm ci`, `yarn`): setup, whatever the name. */
const INSTALL_COMMAND = /^\s*(pnpm|npm|yarn|bun)(\s+(install|i|ci|add)\b|\s*$)/i;
/** Checks that run tests: the only ones that prove a criterion by default. */
const TEST_CHECK =
  /\b(tests?|specs?|e2e|integration|acceptance|smoke|vitest|jest|pytest|playwright|cypress|mocha|ava|tap|rspec|phpunit|cargo\s+test|go\s+test)\b/i;
const bare = (command: string) => command.replace(/^\s*(pnpm|npm|yarn|bun)\s+(run\s+)?/, "");

/** A setup check (install, build) by its name or its command. Never proves a criterion. */
export function isSetupCheck(name: string, command = ""): boolean {
  return (
    SETUP_CHECK.test(name) ||
    INSTALL_COMMAND.test(command) ||
    (!TEST_CHECK.test(bare(command)) && SETUP_CHECK.test(bare(command)))
  );
}

/**
 * Whether a green required CI check run can prove a criterion: not a static or setup one by name
 * (a CI job's command isn't known). The config names which CI checks are required.
 */
export const ciCheckProves = (name: string): boolean => !isStaticCheck(name) && !isSetupCheck(name);

/**
 * Whether a pass of a declared check can prove an acceptance criterion (ADR 0501, amended
 * 2026-11-13). A static check (lint, typecheck, format) never does. The config's `proves` decides
 * otherwise; without it only a check that runs tests does, and never a setup check (install, build)
 * by name: "Admin can revoke tokens [checks: install]" is not proven by an install that passed.
 */
export function checkProves(name: string, command = "", proves?: boolean | undefined): boolean {
  if (isStaticCheck(name, command)) return false;
  if (proves !== undefined) return proves;
  if (isSetupCheck(name, command)) return false;
  return TEST_CHECK.test(name) || TEST_CHECK.test(bare(command));
}

/**
 * The criterion-to-check links an approved spec carries: a criterion that ends with
 * `[checks: tests, e2e]` (a person approved that). Returns the criterion without the tag, and the
 * names; no tag: null.
 */
export function specCheckLinks(
  criterion: string,
): { text: string; checks: string[]; uncovered?: boolean } | null {
  const m = /\s*\[(?:checks?|proven by)\s*:\s*([^\]]*)\]\s*$/i.exec(criterion);
  if (!m) return null;
  const text = criterion.slice(0, m.index).trim();
  // `[checks: none]`: no declared check can prove it (an allowed, visible answer).
  if ((m[1] ?? "").trim().toLowerCase() === NO_CHECK) return { text, checks: [], uncovered: true };
  return {
    text,
    checks: (m[1] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  };
}

/** The tag word for "no declared check can prove this": `[checks: none]`. Never a check's name. */
export const NO_CHECK = "none";

/**
 * Triage's ties for an item without a spec (Workflow feature `triage-ties`), validated in code: each
 * criterion gets the checks triage named that are in `allowed` (the project's declared checks and
 * required CI checks, by their declared spelling); any other name is dropped, so a criterion tied
 * only to unknown names is untied and Not proven. An empty list triage gave says no check can prove
 * it (`[checks: none]`). A tag triage wrote into a criterion's text is stripped: only this field ties.
 * Returns the criteria with canonical tags, and the names dropped.
 */
export function tieCriteria(
  criteria: readonly string[],
  ties: readonly { criterion: string; checks: readonly string[] }[],
  allowed: readonly string[],
): { criteria: string[]; dropped: string[] } {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.;:]$/, "");
  const canonical = new Map<string, string>();
  for (const a of allowed) {
    const k = a.trim().toLowerCase();
    if (k && k !== NO_CHECK && k !== "factory/verify" && !canonical.has(k))
      canonical.set(k, a.trim());
  }
  const byText = new Map<string, readonly string[]>();
  for (const t of ties) {
    const k = norm(specCheckLinks(t.criterion)?.text ?? t.criterion);
    if (!byText.has(k)) byText.set(k, t.checks);
  }
  const dropped: string[] = [];
  const out = criteria.map((c) => {
    const text = specCheckLinks(c)?.text ?? c.trim();
    const named = byText.get(norm(text));
    if (!named) return text;
    if (named.length === 0) return `${text} [checks: ${NO_CHECK}]`;
    const kept: string[] = [];
    for (const n of named) {
      const k = canonical.get(n.trim().toLowerCase());
      if (k) {
        if (!kept.includes(k)) kept.push(k);
      } else dropped.push(n);
    }
    return kept.length ? `${text} [checks: ${kept.join(", ")}]` : text;
  });
  return { criteria: out, dropped };
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
  /**
   * The declared checks with the config's `proves`, so a check that may not prove (setup, or
   * `proves: false`) never does; a check not listed is judged by its name and command.
   */
  declared?: readonly (string | DeclaredCheck)[] | undefined;
  /**
   * Who wrote `specCriteria`'s links: the approved spec (a person), or triage for an item without a
   * spec (the Workflow's `triage-ties` feature), whose names `workItem.triage` validated before any check ran.
   */
  linksFrom?: "spec" | "triage" | undefined;
}

/**
 * Marks each criterion Proven or Not proven (ADR 0501, amended 2026-11-12 three times). The criteria
 * are the approved spec's when there is one (a criterion the reviewer left out is Not proven, one it
 * repeated counts once); for an item without a spec with the Workflow's `triage-ties` feature, triage's validated criteria
 * (`linksFrom: "triage"`); the reviewer's own, de-duplicated, only where there is neither. Only links
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
  const says = new Map<string, boolean | undefined>();
  for (const d of options.declared ?? []) {
    if (typeof d !== "string") says.set(key(d.name), d.proves);
  }
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
    (c): { text: string; checks: string[] | null; uncovered?: boolean } =>
      specCheckLinks(c) ?? { text: c, checks: null },
  );
  const from = options.linksFrom ?? "spec";
  const rows: {
    criterion: string;
    specLinks: string[] | null;
    uncovered: boolean;
    /** From the spec's (or triage's) list, not the reviewer's own. */
    listed: boolean;
    reviewer: CriterionInput | null;
  }[] = [];
  if (spec.length > 0) {
    const seen = new Set<string>();
    for (const s of spec) {
      const t = norm(s.text);
      if (seen.has(t)) continue;
      seen.add(t);
      rows.push({
        criterion: s.text,
        specLinks: s.checks,
        uncovered: s.uncovered === true,
        listed: true,
        reviewer: byText.get(t) ?? null,
      });
    }
  } else {
    for (const c of byText.values())
      rows.push({
        criterion: c.criterion,
        specLinks: null,
        uncovered: false,
        listed: false,
        reviewer: c,
      });
  }
  return rows.map(({ criterion, specLinks, uncovered, listed, reviewer }) => {
    const linkedBy = specLinks ? from : "reviewer";
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
        else if (linkedBy !== "reviewer" && checkProves(n, r.command, says.get(key(n))))
          provenBy.push(n);
        else notCounted.push(n);
      } else if (ciGreen.has(key(n))) {
        if (linkedBy !== "reviewer" && ciCheckProves(n)) provenBy.push(n);
        else notCounted.push(n);
      } else if (ciOther.has(key(n))) {
        // Green, but not a check the project requires: any job the PR added could be called this.
        notCounted.push(n);
      } else unproven.push(n);
    }
    // Triage is an agent: what its ties passed is said, never called Proven (amended 2026-11-13).
    const byTriage = linkedBy === "triage";
    return {
      criterion,
      proven: !byTriage && provenBy.length > 0,
      provenBy: byTriage ? [] : provenBy,
      ...(byTriage && provenBy.length ? { passedTriageCheck: provenBy } : {}),
      ...(from === "triage" && listed ? { fromTriage: true } : {}),
      unproven,
      notCounted,
      linkedBy,
      ...(uncovered ? { uncovered: true } : {}),
      weakened: provenBy.length > 0 && !!options.gateFilesChanged,
      reviewerMet: reviewer?.met ?? false,
      opinion: reviewer ? reviewer.evidence : "The reviewer did not address this criterion.",
    };
  });
}

/**
 * Where a project's checks are set up (docs/checks.md), for the gate's line that says none are.
 * There is no screen to declare checks yet, so this is the docs section.
 */
export const CHECKS_DOCS_URL =
  "https://github.com/timoconnellaus/software-factory/blob/main/docs/checks.md#setting-up-checks";

/**
 * Whether anything is set up that could prove a criterion: a check the project declares, or a CI
 * check its config requires (never `factory/verify`) that reported on the SHA. A required name that
 * never reports proves nothing, so it doesn't count. With nothing set up the gate says so instead
 * of "0/N criteria proven" (the owner's decision, 2026-11-13): a count can only be honest when
 * something could have proven a criterion.
 */
export function checksSetUp(
  declared: readonly string[],
  requiredCi: readonly string[],
  ci: Pick<CiSummary, "checks">,
): boolean {
  if (declared.length > 0) return true;
  const key = (s: string) => s.trim().toLowerCase();
  const required = new Set(requiredCi.map(key).filter((n) => n !== "factory/verify"));
  return ci.checks.some((c) => required.has(key(c.name)));
}

/** Why a criterion is Not proven, in a few words, for the gate. Empty when it is Proven. */
export function whyNotProven(
  p: Pick<
    CriterionProof,
    | "proven"
    | "provenBy"
    | "unproven"
    | "notCounted"
    | "linkedBy"
    | "uncovered"
    | "passedTriageCheck"
  >,
): string {
  if (p.proven) return "";
  if (p.passedTriageCheck?.length) {
    return `passed ${p.passedTriageCheck.join(", ")}, the check triage named (not checked by a person)`;
  }
  if (p.uncovered) return "not covered by a check";
  const named = [...p.unproven, ...p.notCounted];
  if (named.length === 0) return "no check is named for this";
  if (p.linkedBy === "reviewer") {
    return `only the reviewer named ${named.join(", ")}, and a reviewer's link proves nothing`;
  }
  if (p.unproven.length > 0) return `${p.unproven.join(", ")} didn't pass on this commit`;
  return `${p.notCounted.join(", ")} can't prove a criterion (a setup or static check, or a CI job the config doesn't require)`;
}

/**
 * The packet's counts (amended 2026-11-13): `proven` of `total` are criteria a person tied to a
 * check (the approved spec); `triage` counts, apart, criteria from triage's list that passed the
 * check triage named. A triage tie is never counted as proven.
 */
export function proofCounts(proof: readonly CriterionProof[]): {
  proven: number;
  total: number;
  triage?: { passed: number; total: number };
} {
  const person = proof.filter((p) => !p.fromTriage);
  const triage = proof.filter((p) => p.fromTriage);
  return {
    proven: person.filter((p) => p.proven).length,
    total: person.length,
    ...(triage.length
      ? {
          triage: {
            passed: triage.filter((p) => (p.passedTriageCheck?.length ?? 0) > 0).length,
            total: triage.length,
          },
        }
      : {}),
  };
}

/**
 * ADR 0515's condition "every acceptance criterion is proven by a check that ran on the head SHA",
 * for auto-approval (dark factory mode) to read when it is built: only a tie a person approved (the
 * spec's) counts. A criterion that passed the check triage named is NOT proven for this: triage is an
 * agent, and an agent's tie can't let a merge skip a person (amended 2026-11-13). No criteria, or
 * any criterion from triage's list, is false.
 */
export function everyCriterionProven(proof: readonly CriterionProof[]): boolean {
  return proof.length > 0 && proof.every((p) => p.proven && !p.fromTriage);
}

/** One line per executed check, for `factory/verify`'s summary. */
export function checkLines(executed: Pick<ExecutedChecks, "declared" | "results">): string[] {
  return executed.declared.map((name, i) => {
    const r = executed.results[i];
    if (!r) return `${name}: didn't run on this commit`;
    if (r.notRun) return `${name}: not run (${r.notRun})`;
    const how = r.timedOut ? "timed out" : `exit ${r.exitCode ?? "signal"}`;
    const where = r.isolation === "weaker-sandbox" ? ", in the weaker sandbox" : "";
    return `${name}: ${r.passed ? "passed" : "failed"} (\`${r.command}\`, ${how}, ${Math.round(r.durationMs / 1000)} s${where})`;
  });
}
