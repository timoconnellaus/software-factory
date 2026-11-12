// Review-packet assembly (ADR 0020, 0041, spec 04). The packet is the merge gate in the app and it
// backs `factory/verify`. It passes only when the cloud can read green CI on the head SHA AND the
// packet is complete: every acceptance criterion met with evidence, the independent reviewer's
// approval, no failing runner check. The runner's own claim is evidence, never the verdict.
import type { CheckResult } from "@software-factory/runner-contract";
import type { ChangedFile } from "../services.ts";
import type { CiSummary } from "./ci.ts";
import {
  type CheckRun,
  type CriterionProof,
  checkLines,
  type ExecutedChecks,
  executedChecks,
  proveCriteria,
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
  /** The checks the project declares for this item (ADR 0501), by name. */
  declaredChecks?: readonly string[] | undefined;
  /** What the runner host ran on this SHA (core_check_results). */
  checksRun?: readonly CheckRun[] | undefined;
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

  if (evidence.criteria.length === 0) missing.push("no acceptance criteria were checked");
  for (const c of evidence.criteria) {
    if (!c.evidence.trim()) missing.push(`no evidence for "${c.criterion}"`);
  }
  if (!evidence.reviewer) missing.push("no independent reviewer verdict");
  if (input.files === null) missing.push("the diff couldn't be read from GitHub");

  for (const c of evidence.criteria) if (!c.met) reasons.push(`unmet: ${c.criterion}`);
  // The factory's own checks on this SHA decide; the agent's report of checks never does.
  const executed = executedChecks(input.headSha, input.declaredChecks ?? [], input.checksRun ?? []);
  reasons.push(...executed.reasons);
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

  if (executed.declared.length === 0) {
    warnings.push(
      "the project declares no checks, so the factory ran none itself: only CI backs this verdict (ADR 0501)",
    );
  }
  const proof = proveCriteria(evidence.criteria, executed, ci);
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
      executed,
      proof,
      proven: { proven: proof.filter((p) => p.proven).length, total: proof.length },
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
  proven?: { proven: number; total: number } | null;
}): {
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure";
  title: string;
  summary: string;
} {
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
  const summary = [
    `Work item #${args.workItem.number}: ${args.workItem.title}`,
    "",
    ...list("Tests not intact: a person must look at these (ADR 0500)", findings),
    ...list("What fails", args.evidencePass ? [] : args.evidenceReasons),
    ...list("Warnings", args.warnings),
    ...list("Risk flags", args.riskFlags),
    ...list("Checks run by the factory", args.checkLines ?? []),
    ...(args.proven
      ? [
          `Criteria proven by an executed check or CI: ${args.proven.proven}/${args.proven.total}`,
          "",
        ]
      : []),
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
  return {
    status: "completed",
    conclusion: "success",
    title: findingCount
      ? `Verified by the factory; ${findingCount} test finding${findingCount === 1 ? "" : "s"} for a person`
      : "Verified by the factory",
    summary,
  };
}

const short = (sha: string) => sha.slice(0, 7);

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

/** The check lines and proven count stored in a packet's sections (for `verifyCheckOutput`). */
export function storedProof(sections: Record<string, unknown>): {
  checkLines: string[];
  proven: { proven: number; total: number } | null;
} {
  const e = sections.executed as Partial<ExecutedChecks> | undefined;
  const p = sections.proven as { proven?: unknown; total?: unknown } | undefined;
  return {
    checkLines:
      Array.isArray(e?.declared) && Array.isArray(e?.results)
        ? checkLines({ declared: e.declared, results: e.results })
        : [],
    proven:
      typeof p?.proven === "number" && typeof p.total === "number"
        ? { proven: p.proven, total: p.total }
        : null,
  };
}
