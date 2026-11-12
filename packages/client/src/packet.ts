// Reading a stored review packet (reviewPacket.record's shapes, spec 14). The packet is rendered from
// what was stored; nothing here calls GitHub (criterion 6).
import { z } from "zod";
import type { WorkItemDetail } from "./ops.ts";

const criterion = z.object({
  criterion: z.string(),
  met: z.boolean(),
  evidence: z.string(),
  /** The checks the reviewer linked it to (ADR 0501). */
  checks: z.array(z.string()).default([]),
});
const check = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "skipped"]),
  detail: z.string().optional(),
});
const reviewer = z.object({
  role: z.string(),
  model: z.string().optional(),
  verdict: z.enum(["approve", "request_changes"]),
  notes: z.string(),
  sameModelAsImplementer: z.boolean().default(false),
});

export type Criterion = z.infer<typeof criterion>;
export type Check = z.infer<typeof check>;
export type Reviewer = z.infer<typeof reviewer>;

/** Every section the app can render, in the default order (ui-plan: review packet). */
export const PACKET_SECTIONS = [
  "verdict",
  "whatChanged",
  "criteria",
  "holdout",
  "reviewer",
  "visual",
  "risk",
  "diff",
] as const;
export type PacketSection = (typeof PACKET_SECTIONS)[number];

/** Spelling variants a `.factory/policy.json` might use for the same section. */
const ALIASES: Record<string, PacketSection> = {
  verdict: "verdict",
  "verdict-row": "verdict",
  whatchanged: "whatChanged",
  changed: "whatChanged",
  ci: "verdict",
  "what-changed": "whatChanged",
  summary: "whatChanged",
  criteria: "criteria",
  "criteria-evidence": "criteria",
  acceptancecriteria: "criteria",
  holdout: "holdout",
  holdouts: "holdout",
  "holdout-tests": "holdout",
  reviewer: "reviewer",
  "reviewer-notes": "reviewer",
  review: "reviewer",
  visual: "visual",
  screenshots: "visual",
  "visual-evidence": "visual",
  risk: "risk",
  "risk-flags": "risk",
  risks: "risk",
  diff: "diff",
  "inline-diff": "diff",
};

/**
 * The sections to render, in order (criterion 1): the project's `reviewPacket.sections` when it
 * sets them (unknown names are skipped, sections it leaves out are not rendered), else all.
 */
export function packetSections(configured: string[] | null | undefined): PacketSection[] {
  if (!configured) return [...PACKET_SECTIONS];
  const out: PacketSection[] = [];
  for (const name of configured) {
    const key = ALIASES[name.toLowerCase().replace(/[\s_]/g, "-")] ?? ALIASES[name.toLowerCase()];
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export interface ParsedPacket {
  id: string;
  headSha: string;
  verdict: "pass" | "fail";
  summary: string;
  criteria: Criterion[];
  checks: Check[];
  reviewer: Reviewer | null;
  riskFlags: string[];
  sections: Record<string, unknown>;
  createdAt: string;
}

export function parsePacket(packet: NonNullable<WorkItemDetail["reviewPacket"]>): ParsedPacket {
  const many = <T>(schema: z.ZodType<T>, list: unknown[]) =>
    list.flatMap((x) => {
      const r = schema.safeParse(x);
      return r.success ? [r.data] : [];
    });
  const rev = reviewer.safeParse(packet.reviewer);
  return {
    ...packet,
    criteria: many(criterion, packet.criteria),
    checks: many(check, packet.checks),
    reviewer: rev.success ? rev.data : null,
  };
}

/** Evidence the project's evidence policy keeps on the runner (spec 14, criterion 9). */
export function keptOnRunner(evidence: string): string | null {
  const m = /^(?:runner:|kept-on-runner:)\s*(.+)$/i.exec(evidence.trim());
  return m?.[1] ?? null;
}

export function packetCounts(p: ParsedPacket) {
  const checksPassed = p.checks.filter((c) => c.status === "pass").length;
  const checksFailed = p.checks.filter((c) => c.status === "fail").length;
  const met = p.criteria.filter((c) => c.met).length;
  return {
    checksPassed,
    checksFailed,
    checksTotal: p.checks.length,
    met,
    total: p.criteria.length,
  };
}

const ciSection = z.object({
  state: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    }),
  ),
});
const verdictSection = z.object({
  reasons: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
const changedSection = z.object({
  files: z.number().nullable(),
  paths: z
    .array(z.object({ path: z.string(), status: z.string(), previousPath: z.string().optional() }))
    .default([]),
});

export type CiSection = z.infer<typeof ciSection>;

/** The parts the verify stage adds under `sections` (spec 04): CI on the head SHA, why, what changed. */
export function packetExtras(p: ParsedPacket) {
  const ci = ciSection.safeParse(p.sections.ci);
  const verdict = verdictSection.safeParse(p.sections.verdict);
  const changed = changedSection.safeParse(p.sections.changed);
  return {
    ci: ci.success ? ci.data : null,
    reasons: verdict.success ? verdict.data.reasons : [],
    warnings: verdict.success ? verdict.data.warnings : [],
    changed: changed.success ? changed.data : null,
  };
}

const GREEN = new Set(["success", "neutral", "skipped"]);

/** CI's own counts when the packet carries them, else the runner's checks (evidence only). */
export function checkCounts(p: ParsedPacket): {
  passed: number;
  failed: number;
  total: number;
  source: "ci" | "runner";
} {
  const { ci } = packetExtras(p);
  if (ci) {
    const done = ci.checks.filter((c) => c.status === "completed");
    return {
      passed: done.filter((c) => GREEN.has(c.conclusion ?? "")).length,
      failed: done.filter((c) => !GREEN.has(c.conclusion ?? "")).length,
      total: ci.checks.length,
      source: "ci",
    };
  }
  const c = packetCounts(p);
  return { passed: c.checksPassed, failed: c.checksFailed, total: c.checksTotal, source: "runner" };
}

const testsIntactSection = z.object({
  headSha: z.string(),
  intact: z.boolean(),
  findings: z
    .array(
      z.object({
        kind: z.string(),
        path: z.string(),
        line: z.number().nullable(),
        text: z.string().nullable(),
        message: z.string(),
      }),
    )
    .default([]),
  /** How many findings there were in all; the list stops at 100. */
  total: z.number().optional(),
});
export type TestsIntactSection = z.infer<typeof testsIntactSection>;

/**
 * The tests-intact guard's result for the packet's SHA (ADR 0500), or null for a packet from before
 * the guard (which reads as "not checked", never as intact).
 */
export function packetTestsIntact(p: ParsedPacket): TestsIntactSection | null {
  const r = testsIntactSection.safeParse(p.sections.testsIntact);
  return r.success ? r.data : null;
}

const checkOutcome = z.object({
  name: z.string(),
  command: z.string(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean().default(false),
  durationMs: z.number(),
  logTail: z.string().default(""),
  round: z.number().default(0),
  passed: z.boolean(),
});
const executedSection = z.object({
  declared: z.array(z.string()),
  results: z.array(checkOutcome.nullable()),
  extra: z.array(checkOutcome).default([]),
});
const proofSection = z.array(
  z.object({
    criterion: z.string(),
    proven: z.boolean(),
    provenBy: z.array(z.string()).default([]),
    unproven: z.array(z.string()).default([]),
    reviewerMet: z.boolean(),
    opinion: z.string().default(""),
  }),
);
export type CheckOutcome = z.infer<typeof checkOutcome>;
export type CriterionProof = z.infer<typeof proofSection>[number];

/**
 * The project's checks as the runner host ran them on the packet's SHA (ADR 0501): each declared
 * check with its result, or null when it didn't run there. Null for a packet from before.
 */
export function packetExecuted(p: ParsedPacket): {
  rows: { name: string; result: CheckOutcome | null }[];
  extra: CheckOutcome[];
} | null {
  const r = executedSection.safeParse(p.sections.executed);
  if (!r.success) return null;
  return {
    rows: r.data.declared.map((name, i) => ({ name, result: r.data.results[i] ?? null })),
    extra: r.data.extra,
  };
}

/**
 * Each criterion's proof by criterion text (ADR 0501): Proven only by a linked check that passed.
 * Null for a packet from before, whose criteria show the reviewer's met/unmet as before.
 */
export function packetProof(p: ParsedPacket): Map<string, CriterionProof> | null {
  const r = proofSection.safeParse(p.sections.proof);
  return r.success ? new Map(r.data.map((x) => [x.criterion, x])) : null;
}
