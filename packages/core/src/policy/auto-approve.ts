// Dark factory mode (ADR 0515, spec 52 build step (e)): a merge gate approved with no person, when
// the workflow's `autoApprove` setting is on and every condition holds, each checked here in code.
// It only approves: the babysitter (spec 53) lands approved work, whoever approved it.
import { z } from "zod";

/**
 * The merge stage's setting (ADR 0515 §4): off by default. Turning it on, raising a limit or
 * removing a path loosens (`autoApproveImpact`), so only an org admin saves it and approves it.
 */
export const autoApproveSettings = z
  .object({
    enabled: z.boolean().default(false),
    maxChangedLines: z.number().int().min(1).max(5_000).default(200),
    maxFiles: z.number().int().min(1).max(200).default(10),
    /** Globs no auto-approved change may touch, on top of the floors. */
    forbiddenPaths: z.array(z.string().min(1).max(200)).max(100).default([]),
    /** Globs that make a change risky, on top of `RISK_PATHS`. */
    riskPaths: z.array(z.string().min(1).max(200)).max(100).default([]),
  })
  .strict();
export type AutoApproveSettings = z.infer<typeof autoApproveSettings>;
export const AUTO_APPROVE_OFF: AutoApproveSettings = autoApproveSettings.parse({});

/**
 * The risk floor in code (ADR 0515 §4): migrations, auth, billing, secrets and environment files, CI
 * and repository settings, factory policy. A workflow's lists only add to it. Lock files are risky
 * only without a matching manifest change (`lockWithoutManifest`).
 */
export const RISK_PATHS = [
  "**/migrations/**",
  "**/*.sql",
  "**/auth/**",
  "**/*auth*.*",
  "**/billing/**",
  "**/payments/**",
  "**/.env*",
  "**/.dev.vars*",
  "**/wrangler.*",
  ".github/**",
  ".factory/**",
] as const;

/**
 * Changes to the factory itself (ADR 0515 §4–5, decided by the owner): excluded from auto-approval in
 * every workflow on every repository. No setting removes a path from this list.
 */
export const SELF_MODIFY_PATHS = [
  ".factory/**",
  "packages/core/src/policy/**",
  "packages/core/src/gate.ts",
  "packages/core/src/registry.ts",
  "packages/core/src/operations/**",
  "packages/core/src/stages/**",
  "apps/engine/src/workflow/**",
  "AGENTS.md",
  "docs/adr/**",
] as const;

const LOCKS: Record<string, string[]> = {
  "pnpm-lock.yaml": ["package.json"],
  "package-lock.json": ["package.json"],
  "yarn.lock": ["package.json"],
  "bun.lockb": ["package.json"],
  "Cargo.lock": ["Cargo.toml"],
  "poetry.lock": ["pyproject.toml"],
  "Gemfile.lock": ["Gemfile"],
  "go.sum": ["go.mod"],
};

/** A glob over repository paths: `**` any directories, `*` within one segment. Case-insensitive. */
export function globMatch(glob: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more directories; a trailing `**` anything.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(path);
}

const matching = (globs: readonly string[], paths: readonly string[]) =>
  paths.filter((p) => globs.some((g) => globMatch(g, p)));

/** Lock files changed with no manifest beside them changed: risky (ADR 0515 §4). */
export function lockWithoutManifest(paths: readonly string[]): string[] {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return paths.filter((p) => {
    const slash = p.lastIndexOf("/");
    const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
    const name = p.slice(slash + 1);
    const manifests = LOCKS[name];
    return !!manifests && !manifests.some((m) => set.has(`${dir}${m}`.toLowerCase()));
  });
}

/** What the factory read about one merge gate, on one head SHA. Null: it couldn't be read. */
export interface AutoApproveFacts {
  headSha: string;
  /** The review packet on this SHA: its verdict, CI, the criteria proven, tests intact. */
  packet: {
    verdict: "pass" | "fail";
    ci: string | null;
    proven: { proven: number; total: number } | null;
    testsIntact: boolean | null;
  } | null;
  /** The adjudicator: active for merge on this project, earned, and its verdict on this SHA. */
  adjudicator: { active: boolean; eligible: boolean; approved: boolean } | null;
  /** GitHub's compare of the default branch with the head. */
  changes: { path: string; changes: number | null }[] | null;
  /** The project's hold (ADR 0515 §7), if set. */
  hold: string | null;
  /** The merge would change the factory's own config (the gate's `touchesFactoryConfig`). */
  touchesFactoryConfig: boolean;
}

export type AutoApproveCondition =
  | "enabled"
  | "hold"
  | "checks"
  | "tests"
  | "adjudicator"
  | "limits"
  | "risk";

export interface AutoApproveVerdict {
  approve: boolean;
  conditions: { id: AutoApproveCondition; ok: boolean; why: string }[];
  /** The first condition that sent it to a person, for the gate's card. */
  reason: string;
}

/**
 * Whether the merge gate is approved with no person (ADR 0515 §3): the setting is on, no hold, and
 * all five conditions hold. Anything unread is a failed condition: it goes to a person.
 */
export function autoApproveVerdict(
  facts: AutoApproveFacts,
  setting: AutoApproveSettings,
): AutoApproveVerdict {
  const conditions: AutoApproveVerdict["conditions"] = [];
  const add = (id: AutoApproveCondition, ok: boolean, why: string) =>
    conditions.push({ id, ok, why });
  add(
    "enabled",
    setting.enabled,
    setting.enabled ? "the workflow auto-approves merges" : "the workflow's autoApprove is off",
  );
  add(
    "hold",
    !facts.hold,
    facts.hold ? `the project's auto-approval is held: ${facts.hold}` : "no hold",
  );
  const p = facts.packet;
  const proven = p?.proven;
  add(
    "checks",
    !!p &&
      p.verdict === "pass" &&
      p.ci === "success" &&
      !!proven &&
      proven.total > 0 &&
      proven.proven === proven.total,
    !p
      ? "no review packet on this commit"
      : p.verdict !== "pass"
        ? "the review packet didn't pass"
        : p.ci !== "success"
          ? `CI on this commit is ${p.ci ?? "unknown"}`
          : !proven || proven.total === 0
            ? "no acceptance criterion is proven by a check that ran"
            : proven.proven < proven.total
              ? `${proven.total - proven.proven} of ${proven.total} criteria aren't proven by a check that ran`
              : "every check passed and every criterion is proven",
  );
  add(
    "tests",
    p?.testsIntact === true,
    p?.testsIntact === true ? "tests intact" : "the tests-intact guard didn't pass on this commit",
  );
  const a = facts.adjudicator;
  add(
    "adjudicator",
    !!a && a.active && a.eligible && a.approved,
    !a || !a.active
      ? "the adjudicator isn't active for merges on this project"
      : !a.eligible
        ? "the adjudicator hasn't earned merges on this project"
        : !a.approved
          ? "the adjudicator didn't approve this commit"
          : "the adjudicator approved this commit",
  );
  const changes = facts.changes;
  const paths = changes?.map((c) => c.path) ?? [];
  const lines = changes?.reduce((n, c) => n + (c.changes ?? Number.POSITIVE_INFINITY), 0) ?? null;
  const forbidden = matching(setting.forbiddenPaths, paths);
  add(
    "limits",
    !!changes &&
      changes.length <= setting.maxFiles &&
      lines !== null &&
      lines <= setting.maxChangedLines &&
      forbidden.length === 0,
    !changes
      ? "the change couldn't be read from GitHub"
      : changes.length > setting.maxFiles
        ? `${changes.length} files changed (the limit is ${setting.maxFiles})`
        : lines === null || !Number.isFinite(lines)
          ? "a file's changed lines couldn't be counted"
          : lines > setting.maxChangedLines
            ? `${lines} lines changed (the limit is ${setting.maxChangedLines})`
            : forbidden.length
              ? `touches a forbidden path: ${forbidden.slice(0, 5).join(", ")}`
              : "inside the size and path limits",
  );
  const self = matching(SELF_MODIFY_PATHS, paths);
  const risky = [
    ...matching([...RISK_PATHS, ...setting.riskPaths], paths),
    ...lockWithoutManifest(paths),
  ];
  add(
    "risk",
    !!changes && !facts.touchesFactoryConfig && self.length === 0 && risky.length === 0,
    !changes
      ? "the change couldn't be read from GitHub"
      : facts.touchesFactoryConfig || self.length
        ? `a change to the factory itself${self.length ? `: ${self.slice(0, 5).join(", ")}` : ""}`
        : risky.length
          ? `touches a risk path: ${[...new Set(risky)].slice(0, 5).join(", ")}`
          : "low risk",
  );
  const failed = conditions.find((c) => !c.ok);
  return {
    approve: !failed,
    conditions,
    reason: failed ? failed.why : "auto-approved: every condition held",
  };
}

/** How a change of the setting classifies (ADR 0515 §2): on, raised limits, fewer paths loosen. */
export function autoApproveImpact(
  before: AutoApproveSettings,
  after: AutoApproveSettings,
  path: string,
): { path: string; class: "loosens" | "tightens" | "neutral"; summary: string }[] {
  const out: { path: string; class: "loosens" | "tightens" | "neutral"; summary: string }[] = [];
  if (before.enabled !== after.enabled)
    out.push({
      path: `${path}.enabled`,
      class: after.enabled ? "loosens" : "tightens",
      summary: `Merges ${after.enabled ? "are approved automatically when every condition holds" : "always go to a person"}.`,
    });
  for (const key of ["maxChangedLines", "maxFiles"] as const) {
    if (before[key] === after[key]) continue;
    out.push({
      path: `${path}.${key}`,
      class: after[key] > before[key] ? "loosens" : "tightens",
      summary: `Auto-approval ${key === "maxFiles" ? "file" : "changed-line"} limit ${before[key]} → ${after[key]}.`,
    });
  }
  for (const key of ["forbiddenPaths", "riskPaths"] as const) {
    const dropped = before[key].filter((x) => !after[key].includes(x));
    const added = after[key].filter((x) => !before[key].includes(x));
    if (dropped.length)
      out.push({
        path: `${path}.${key}`,
        class: "loosens",
        summary: `No longer ${key === "riskPaths" ? "risky" : "forbidden"}: ${dropped.join(", ")}.`,
      });
    if (added.length)
      out.push({
        path: `${path}.${key}`,
        class: "tightens",
        summary: `Also ${key === "riskPaths" ? "risky" : "forbidden"}: ${added.join(", ")}.`,
      });
  }
  return out;
}
