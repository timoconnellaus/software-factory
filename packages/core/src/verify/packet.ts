// Review-packet assembly (ADR 0020, 0041, spec 04). The packet is the merge gate in the app and it
// backs `factory/verify`. It passes only when the cloud can read green CI on the head SHA AND the
// packet is complete: every acceptance criterion met with evidence, the independent reviewer's
// approval, no failing runner check. The runner's own claim is evidence, never the verdict.
import type { CheckResult } from "@software-factory/runner-contract";
import type { ChangedFile } from "../services.ts";
import type { CiSummary } from "./ci.ts";
import {
  CHECKS_DOCS_URL,
  type CheckRun,
  type CriterionProof,
  checkLines,
  checksSetUp,
  type DeclaredCheck,
  type ExecutedChecks,
  executedChecks,
  notRunLines,
  notRunTitle,
  proofCounts,
  proveCriteria,
  weakerLines,
  whyNotProven,
} from "./proof.ts";
import { type RiskFlag, riskFlags } from "./risk.ts";
import { type TestsIntact, testFindingLines, testsIntact } from "./tests-intact.ts";

export interface PacketEvidence {
  summary: string;
  /** The reviewer's judgement per criterion, and the checks it links each to (ADR 0501). */
  criteria: { criterion: string; met: boolean; evidence: string; checks?: string[] | undefined }[];
  /** What the reviewer agent says it ran: its opinion, never the verdict (ADR 0501). */
  checks: CheckResult[];
  reviewer: {
    role: "review";
    model?: string | undefined;
    verdict: "approve" | "request_changes";
    notes: string;
  } | null;
  /** Flags the reviewer raised. */
  riskFlags: string[];
}

export interface PacketInput {
  headSha: string;
  evidence: PacketEvidence;
  ci: CiSummary;
  /** GitHub's compare of the default branch with the head; null when it couldn't be read. */
  files: ChangedFile[] | null;
  /** True when `review` and `implement` resolve to the same model (spec 04, criterion 5). */
  sameModelAsImplementer: boolean;
  /** What the runner said (kept in the packet; never decides). */
  runnerVerdict?: "pass" | "fail" | undefined;
  /** The checks the project declares for this item (ADR 0501): names, and the commands now. */
  declaredChecks?: readonly (string | DeclaredCheck)[] | undefined;
  /** The CI checks the project's config requires: the only CI runs that may prove a criterion. */
  requiredCi?: readonly string[] | undefined;
  /** What the runner host ran on this SHA (core_check_results). */
  checksRun?: readonly CheckRun[] | undefined;
  /**
   * Whether the item runs the factory's own checks (Workflow v8+, ADR 0501). False for an instance
   * that started earlier: its verdict stays as it was (the agent's failing checks fail it), with no
   * executed checks or proof.
   */
  hostChecks?: boolean | undefined;
  /** The approved spec's acceptance criteria, for the links a person approved (ADR 0501). */
  specCriteria?: readonly string[] | null | undefined;
  /** Who wrote `specCriteria`'s links: the approved spec, or triage (the Workflow's `triage-ties` feature). */
  linksFrom?: "spec" | "triage" | undefined;
  /**
   * A split parent's PR (spec 24): the only files it may add or change, the first being the spec.
   * The verdict is then decided in code from the diff and CI: any other path, or a file removed or
   * renamed, fails it, so this path can't carry code to main without criteria being judged.
   */
  splitFiles?: readonly string[] | null | undefined;
}

export interface AssembledPacket {
  verdict: "pass" | "fail";
  /** Everything but CI passed: the packet is complete and nothing in it failed. */
  evidencePass: boolean;
  /** Why the evidence fails, CI aside (what `factory/verify` re-reads when CI changes). */
  evidenceReasons: string[];
  /** Why the verdict is what it is, one line each; empty when it passed. */
  reasons: string[];
  /** Parts a complete packet needs that are missing. */
  missing: string[];
  warnings: string[];
  risk: RiskFlag[];
  /** Flags for the packet's `risk_flags` column: the computed ones, then the reviewer's. */
  riskFlags: string[];
  /**
   * Whether the diff weakens the tests (ADR 0500). Never part of the verdict and never from an
   * agent: a person looks at the findings at the merge gate, and they block the auto-merge.
   */
  testsIntact: TestsIntact;
  /** The declared checks as the host ran them on the SHA (ADR 0501). */
  executed: ExecutedChecks;
  /** Each criterion, Proven only by a linked check that passed on the SHA. */
  proof: CriterionProof[];
  sections: Record<string, unknown>;
}

export function assemblePacket(input: PacketInput): AssembledPacket {
  const { evidence, ci } = input;
  const missing: string[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];

  const split = input.splitFiles ?? null;
  if (split) {
    // Spec 24: exactly the approved spec and .kim/ files, added or changed; nothing else.
    const allowed = new Set(split);
    for (const f of input.files ?? []) {
      if (!allowed.has(f.path)) reasons.push(`not one of the approved plan's files: ${f.path}`);
      else if (f.status !== "added" && f.status !== "modified")
        reasons.push(`the approved plan's file was ${f.status}: ${f.path}`);
      if (f.previousPath && !allowed.has(f.previousPath))
        reasons.push(`not one of the approved plan's files: ${f.previousPath}`);
    }
    const spec = split[0];
    if (spec && input.files && !input.files.some((f) => f.path === spec))
      missing.push(`the approved spec (${spec}) isn't in the pull request`);
  } else {
    if (evidence.criteria.length === 0) missing.push("no acceptance criteria were checked");
    for (const c of evidence.criteria) {
      if (!c.evidence.trim()) missing.push(`no evidence for "${c.criterion}"`);
    }
    if (!evidence.reviewer) missing.push("no independent reviewer verdict");
  }
  if (input.files === null) missing.push("the diff couldn't be read from GitHub");

  for (const c of evidence.criteria) if (!c.met) reasons.push(`unmet: ${c.criterion}`);
  // The factory's own checks on this SHA decide (ADR 0501). The agent's report of checks decides
  // only where the factory has none: an older instance, or a project that declares no checks, so
  // a reviewer's failing test still fails verify.
  const hostChecks = input.hostChecks ?? false;
  const executed = executedChecks(
    input.headSha,
    hostChecks ? (input.declaredChecks ?? []) : [],
    hostChecks ? (input.checksRun ?? []) : [],
  );
  reasons.push(...executed.reasons);
  if (executed.declared.length === 0) {
    for (const c of evidence.checks) {
      if (c.status === "fail") reasons.push(`runner check failing: ${c.name}`);
    }
  }
  if (evidence.reviewer?.verdict === "request_changes") {
    reasons.push("the reviewer requested changes");
  }
  if (input.sameModelAsImplementer) {
    warnings.push(
      "the reviewer resolves to the same model as the implementer: the review is not independent",
    );
  }
  const evidencePass = missing.length === 0 && reasons.length === 0;

  const ciReasons =
    ci.state === "success"
      ? []
      : ci.state === "failure"
        ? [`CI failing on ${short(input.headSha)}: ${ci.failing.join(", ")}`]
        : ci.state === "pending"
          ? [`CI still running on ${short(input.headSha)}: ${ci.pending.join(", ")}`]
          : [`no CI has reported on ${short(input.headSha)}`];
  if (input.runnerVerdict === "pass" && ci.state !== "success") {
    warnings.push("the runner reported green, but CI on GitHub isn't: CI decides (spec 04)");
  }

  // Checks the runner could not run: said plainly, never a pass, never a failure (third review, B3).
  // `factory/verify` is then not success but action required (fourth review, S2): a person merges
  // only by deciding to merge without them (review.merge).
  warnings.push(...notRunLines(executed.notRun));
  warnings.push(...weakerLines(executed.weaker));
  if (hostChecks && executed.declared.length === 0) {
    warnings.push(
      "the project declares no checks, so the factory ran none itself: only CI and the reviewer's report back this verdict (ADR 0501)",
    );
  }
  const risk = input.files ? riskFlags(input.files) : [];
  const intact: TestsIntact = input.files
    ? testsIntact(input.headSha, input.files)
    : {
        headSha: input.headSha,
        intact: false,
        findings: [
          {
            kind: "unreadable",
            path: "",
            line: null,
            text: null,
            message: "the diff couldn't be read from GitHub, so nothing says the tests are intact",
          },
        ],
        total: 1,
      };
  const proof = hostChecks
    ? proveCriteria(evidence.criteria, executed, ci, {
        specCriteria: input.specCriteria,
        linksFrom: input.linksFrom,
        declared: input.declaredChecks,
        requiredCi: input.requiredCi,
        gateFilesChanged: intact.findings.some((f) => f.kind === "gate-file"),
      })
    : [];
  const verdict = evidencePass && ci.state === "success" ? "pass" : "fail";
  const evidenceReasons = [...missing.map((m) => `incomplete: ${m}`), ...reasons];
  const allReasons = [...ciReasons, ...evidenceReasons];
  return {
    verdict,
    evidencePass,
    evidenceReasons,
    reasons: verdict === "pass" ? [] : allReasons,
    missing,
    warnings,
    risk,
    riskFlags: [...risk.map((r) => r.message), ...evidence.riskFlags],
    testsIntact: intact,
    executed,
    proof,
    sections: {
      testsIntact: intact,
      ...(hostChecks
        ? {
            executed,
            proof,
            proven: {
              // Person-tied criteria proven, and triage's ties counted apart (amended 2026-11-13).
              ...proofCounts(proof),
              weakened: proof.some((p) => p.weakened),
              // Nothing declared and no required CI reported: nothing could prove a criterion, so
              // the gate says that rather than "0/N proven".
              checksSetUp: checksSetUp(executed.declared, input.requiredCi ?? [], ci),
            },
          }
        : {}),
      verdict: { verdict, reasons: verdict === "pass" ? [] : allReasons, warnings },
      ci: { state: ci.state, checks: ci.checks },
      changed: input.files
        ? { files: input.files.length, paths: input.files.slice(0, 200) }
        : { files: null },
      risk: risk.map(({ kind, message, paths }) => ({ kind, message, paths: paths.slice(0, 20) })),
      runner: { verdict: input.runnerVerdict ?? null, checks: evidence.checks },
      evidencePass,
      evidenceReasons,
    },
  };
}

/** A person's decision to merge without the checks the runner could not run (fourth review). */
export interface NotRunWaiver {
  by: string;
  at: string;
  checks: string[];
}

/** What `factory/verify` is posted as. */
export interface VerifyOutput {
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure" | "action_required";
  title: string;
  summary: string;
}

/** The `factory/verify` check run's text for a packet's evidence and the CI as it stands now. */
export function verifyCheckOutput(args: {
  evidencePass: boolean;
  evidenceReasons: string[];
  warnings: string[];
  riskFlags: string[];
  ci: CiSummary;
  workItem: { number: number; title: string };
  /** The tests-intact findings for this SHA (ADR 0500): shown first, for a person. */
  testFindings?: string[];
  /** How many findings there were in all (the lines may stop at MAX_FINDINGS). */
  testFindingsTotal?: number;
  /** The factory's own checks on this SHA, one line each (ADR 0501). */
  checkLines?: string[];
  /** How many criteria an executed check proves. */
  proven?: StoredProven | null;
  /** Each criterion not proven, with why ("no check is named for this"). */
  unprovenLines?: string[];
  /**
   * Declared checks the runner could not run on this SHA (fourth review, S2): with everything else
   * passing, the check is action required, not success, until a person decides at the merge gate.
   */
  notRun?: ExecutedChecks["notRun"];
  /** A person decided to merge without those checks (review.merge): recorded, then success. */
  notRunWaived?: NotRunWaiver | null;
}): VerifyOutput {
  const { ci } = args;
  const list = (title: string, items: string[]) =>
    items.length ? [`### ${title}`, ...items.map((i) => `- ${i}`), ""] : [];
  const ciLine = `CI: ${ci.state}${
    ci.checks.length
      ? ` (${ci.checks.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ")})`
      : ""
  }`;
  const findings = args.testFindings ?? [];
  const findingCount = args.testFindingsTotal ?? findings.length;
  const notRun = args.notRun ?? [];
  const waived = notRun.length > 0 ? (args.notRunWaived ?? null) : null;
  const summary = [
    `Work item #${args.workItem.number}: ${args.workItem.title}`,
    "",
    ...list(
      waived
        ? `Not run on this runner: a person decided to merge without these checks (${waived.at.slice(0, 10)})`
        : "Not run on this runner: not passed, proving nothing; a person decides at the merge gate",
      notRun.map((n) => `${n.name}: ${n.reason}`),
    ),
    ...list("Tests not intact: a person must look at these (ADR 0500)", findings),
    ...list("What fails", args.evidencePass ? [] : args.evidenceReasons),
    ...list("Warnings", args.warnings),
    ...list("Risk flags", args.riskFlags),
    ...list("Checks run by the factory", args.checkLines ?? []),
    ...(args.proven ? provenLines(args.proven, args.unprovenLines ?? []) : []),
    ciLine,
  ].join("\n");
  if (!args.evidencePass) {
    return {
      status: "completed",
      conclusion: "failure",
      title: "The review packet failed",
      summary,
    };
  }
  if (ci.state === "pending") {
    return { status: "in_progress", title: "Waiting for CI on this commit", summary };
  }
  if (ci.state !== "success") {
    return {
      status: "completed",
      conclusion: "failure",
      title:
        ci.state === "failure"
          ? "CI is failing on this commit"
          : "No CI has reported on this commit",
      summary,
    };
  }
  // Everything else passed, but declared checks could not be run: not success (fourth review, S2).
  if (notRun.length > 0 && !waived) {
    return {
      status: "completed",
      conclusion: "action_required",
      title: notRunTitle(notRun),
      summary,
    };
  }
  const tail = [
    ...(findingCount
      ? [`${findingCount} test finding${findingCount === 1 ? "" : "s"} for a person`]
      : []),
    ...(waived
      ? [
          `merged without ${notRun.length} check${notRun.length === 1 ? "" : "s"} that could not be run, by a person's decision`,
        ]
      : []),
  ];
  return {
    status: "completed",
    conclusion: "success",
    title: tail.length ? `Verified by the factory; ${tail.join("; ")}` : "Verified by the factory",
    summary,
  };
}

const short = (sha: string) => sha.slice(0, 7);

/** The proven count as a packet stores it. `checksSetUp: false`: nothing could prove a criterion. */
export interface StoredProven {
  proven: number;
  total: number;
  /** Criteria from triage's list that passed the check triage named: never "proven". */
  triage?: { passed: number; total: number };
  weakened?: boolean;
  checksSetUp?: boolean;
}

/**
 * The summary's proof lines. With no checks set up at all it says so, never "0/N proven"; with
 * checks, the count and why each criterion not proven isn't (the owner's decision, 2026-11-13).
 */
function provenLines(p: StoredProven, unproven: string[]): string[] {
  if (p.checksSetUp === false) {
    return [
      `No checks are set up for this project, so nothing can be proven. How to set them up: ${CHECKS_DOCS_URL}`,
      "",
    ];
  }
  const weakened = p.weakened
    ? " (weakened: the tests-intact guard found gate-file edits on this commit)"
    : "";
  return [
    ...(p.total > 0 || !p.triage
      ? [`Criteria proven by an executed check: ${p.proven}/${p.total}${weakened}`]
      : []),
    ...(p.triage
      ? [
          `Criteria that passed the check triage named (not checked by a person, not proven): ${p.triage.passed}/${p.triage.total}`,
        ]
      : []),
    ...unproven.map((u) => `- ${u}`),
    "",
  ];
}

/** The tests-intact finding lines stored in a packet's sections (for `verifyCheckOutput`). */
export function storedTestFindings(sections: Record<string, unknown>): {
  testFindings: string[];
  testFindingsTotal: number;
} {
  const t = sections.testsIntact as Partial<TestsIntact> | undefined;
  if (!Array.isArray(t?.findings)) return { testFindings: [], testFindingsTotal: 0 };
  const total = typeof t.total === "number" ? t.total : t.findings.length;
  return { testFindings: testFindingLines(t.findings, total), testFindingsTotal: total };
}

/**
 * The check lines and proven count stored in a packet's sections (for `verifyCheckOutput`). A
 * packet the merge queue carried to a new head (`checksRanOn`) says where its checks ran: they
 * didn't run on the commit the check run is posted on (ADR 0501).
 */
export function storedProof(sections: Record<string, unknown>): {
  checkLines: string[];
  proven: StoredProven | null;
  unprovenLines: string[];
  notRun: ExecutedChecks["notRun"];
  notRunWaived: NotRunWaiver | null;
} {
  const e = sections.executed as Partial<ExecutedChecks> | undefined;
  const p = sections.proven as
    | {
        proven?: unknown;
        total?: unknown;
        weakened?: unknown;
        checksSetUp?: unknown;
        triage?: { passed?: unknown; total?: unknown };
      }
    | undefined;
  const ranOn = typeof sections.checksRanOn === "string" ? sections.checksRanOn : null;
  const lines =
    Array.isArray(e?.declared) && Array.isArray(e?.results)
      ? checkLines({ declared: e.declared, results: e.results })
      : [];
  return {
    checkLines: ranOn
      ? lines.map(
          (l) => `${l} — ran on ${short(ranOn)}, not on this commit (carried by the merge queue)`,
        )
      : lines,
    proven:
      typeof p?.proven === "number" && typeof p.total === "number"
        ? {
            proven: p.proven,
            total: p.total,
            ...(p.weakened === true ? { weakened: true } : {}),
            ...(typeof p.checksSetUp === "boolean" ? { checksSetUp: p.checksSetUp } : {}),
            ...(typeof p.triage?.passed === "number" && typeof p.triage.total === "number"
              ? { triage: { passed: p.triage.passed, total: p.triage.total } }
              : {}),
          }
        : null,
    unprovenLines: storedUnproven(sections),
    notRun: storedNotRun(sections),
    notRunWaived: storedWaiver(sections),
  };
}

/** "Not proven: <criterion> (<why>)" for each criterion not proven, from a packet's sections. */
function storedUnproven(sections: Record<string, unknown>): string[] {
  if (!Array.isArray(sections.proof)) return [];
  return sections.proof.flatMap((x: unknown) => {
    const r = x as Partial<CriterionProof> | null;
    if (!r || typeof r.criterion !== "string" || r.proven !== false) return [];
    const why = whyNotProven({
      proven: false,
      provenBy: [],
      unproven: Array.isArray(r.unproven) ? r.unproven : [],
      notCounted: Array.isArray(r.notCounted) ? r.notCounted : [],
      linkedBy: r.linkedBy === "spec" || r.linkedBy === "triage" ? r.linkedBy : "reviewer",
      uncovered: r.uncovered === true,
      passedTriageCheck: Array.isArray(r.passedTriageCheck) ? r.passedTriageCheck : [],
    });
    return [`Not proven: ${r.criterion} (${why})`];
  });
}

/** The declared checks not run on the packet's SHA, from its sections. */
export function storedNotRun(sections: Record<string, unknown>): ExecutedChecks["notRun"] {
  const e = sections.executed as { notRun?: unknown } | undefined;
  if (!Array.isArray(e?.notRun)) return [];
  return e.notRun.flatMap((n: unknown) => {
    const x = n as { name?: unknown; reason?: unknown } | null;
    return typeof x?.name === "string" && typeof x.reason === "string"
      ? [{ name: x.name, reason: x.reason }]
      : [];
  });
}

/** The recorded decision to merge without the checks not run, from a packet's sections. */
export function storedWaiver(sections: Record<string, unknown>): NotRunWaiver | null {
  const w = sections.notRunWaived as { by?: unknown; at?: unknown; checks?: unknown } | undefined;
  if (typeof w?.by !== "string" || typeof w.at !== "string") return null;
  return {
    by: w.by,
    at: w.at,
    checks: Array.isArray(w.checks) ? w.checks.filter((c) => typeof c === "string") : [],
  };
}
