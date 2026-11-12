// Review-packet assembly (ADR 0020, 0041, spec 04). The packet is the merge gate in the app and it
// backs `factory/verify`. It passes only when the cloud can read green CI on the head SHA AND the
// packet is complete: every acceptance criterion met with evidence, the independent reviewer's
// approval, no failing runner check. The runner's own claim is evidence, never the verdict.
import type { CheckResult } from "@software-factory/runner-contract";
import type { ChangedFile } from "../services.ts";
import type { CiSummary } from "./ci.ts";
import { type RiskFlag, riskFlags } from "./risk.ts";
import { type TestsIntact, testFindingLines, testsIntact } from "./tests-intact.ts";

export interface PacketEvidence {
  summary: string;
  criteria: { criterion: string; met: boolean; evidence: string }[];
  /** What the runner ran in its worktree (tests, lint, typecheck): evidence only. */
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
  for (const c of evidence.checks) {
    if (c.status === "fail") reasons.push(`runner check failing: ${c.name}`);
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
    sections: {
      testsIntact: intact,
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
  const summary = [
    `Work item #${args.workItem.number}: ${args.workItem.title}`,
    "",
    ...list("Tests not intact: a person must look at these (ADR 0500)", findings),
    ...list("What fails", args.evidencePass ? [] : args.evidenceReasons),
    ...list("Warnings", args.warnings),
    ...list("Risk flags", args.riskFlags),
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
    title: findings.length
      ? `Verified by the factory; ${findings.length} test finding${findings.length === 1 ? "" : "s"} for a person`
      : "Verified by the factory",
    summary,
  };
}

const short = (sha: string) => sha.slice(0, 7);

/** The tests-intact finding lines stored in a packet's sections (for `verifyCheckOutput`). */
export function storedTestFindings(sections: Record<string, unknown>): string[] {
  const t = sections.testsIntact as Partial<TestsIntact> | undefined;
  return Array.isArray(t?.findings) ? testFindingLines(t.findings) : [];
}
