// Reading a stored review packet (reviewPacket.record's shapes, spec 14). The packet is rendered from
// what was stored; nothing here calls GitHub (criterion 6).
import { z } from "zod";
import type { WorkItemDetail } from "./ops.ts";

const criterion = z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string() });
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
