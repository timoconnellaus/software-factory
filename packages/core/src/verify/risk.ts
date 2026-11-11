// Risk flags for the review packet (ADR 0020, spec 04): what in a diff deserves a person's closer
// look. Computed from GitHub's compare, not from the runner. A diff that touches `.factory/` is
// self-modify (ADR 0036): its merge always needs a person, and the flag says what it changes.
import type { ChangedFile } from "../services.ts";

export const RISK_FLAG_KINDS = [
  "factory-config",
  "permissions",
  "auth",
  "migrations",
  "deps",
] as const;
export type RiskFlagKind = (typeof RISK_FLAG_KINDS)[number];

export interface RiskFlag {
  kind: RiskFlagKind;
  /** One line for the packet's risk section. */
  message: string;
  paths: string[];
}

const RULES: { kind: RiskFlagKind; test: (path: string) => boolean; what: string }[] = [
  {
    kind: "factory-config",
    test: (p) => p === ".factory" || p.startsWith(".factory/"),
    what: "self-modify: changes the project's `.factory/` (its merge always needs a person)",
  },
  {
    kind: "permissions",
    test: (p) =>
      p.startsWith(".github/workflows/") ||
      /(^|\/)CODEOWNERS$/.test(p) ||
      /(^|\/)wrangler\.(jsonc?|toml)$/.test(p) ||
      p.startsWith(".claude/") ||
      /(^|\/)policy\/(gate|project-policy)\.ts$/.test(p) ||
      /(^|\/)\.github\/(rulesets|settings)/.test(p),
    what: "permissions: CI workflows, bindings, harness settings or the gate",
  },
  {
    kind: "auth",
    test: (p) =>
      /(^|[/_.-])(auth|oauth|session|sessions|login|passkey|password|secrets?|tokens?|crypto)([/_.-]|$)/i.test(
        p,
      ) || /(^|\/)\.dev\.vars/.test(p),
    what: "auth: sign-in, sessions, tokens or secrets",
  },
  {
    kind: "migrations",
    test: (p) => /(^|\/)migrations\//.test(p) || /\.sql$/.test(p),
    what: "migrations: changes the database schema",
  },
  {
    kind: "deps",
    test: (p) =>
      /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|\.nvmrc|\.npmrc)$/.test(
        p,
      ),
    what: "deps: dependencies or the toolchain",
  },
];

/** The risk flags a diff raises, in a fixed order. Renames count under both names. */
export function riskFlags(files: readonly ChangedFile[]): RiskFlag[] {
  const paths = files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path]));
  const out: RiskFlag[] = [];
  for (const rule of RULES) {
    const hit = [...new Set(paths.filter(rule.test))];
    if (hit.length === 0) continue;
    const shown = hit.slice(0, 3).join(", ");
    const more = hit.length > 3 ? ` (+${hit.length - 3} more)` : "";
    out.push({ kind: rule.kind, message: `${rule.what}: ${shown}${more}`, paths: hit });
  }
  return out;
}
