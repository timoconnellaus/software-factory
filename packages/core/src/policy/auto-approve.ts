// Dark factory mode (ADR 0515, spec 52 build step (e)): a merge gate approved with no person, when
// the workflow's `autoApprove` setting is on and every condition holds, each checked here in code.
// It only approves: the babysitter (spec 53) lands approved work, whoever approved it.
import { z } from "zod";
import { type CriterionProof, everyCriterionProven } from "../verify/proof.ts";

/**
 * The merge stage's setting (ADR 0515 §4): off by default. Turning it on, raising a limit or
 * removing a path loosens (`autoApproveImpact`), so only an org admin saves it and approves it.
 */
export const autoApproveSettings = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Dark factory mode: a merge is approved with no person only when every condition holds: the packet passed on this commit with every criterion proven by a check tied to it in a spec a person approved; tests intact; the adjudicator approved, having earned it; inside the size limits; every changed path inside allowPaths (the places an unattended change may touch: nothing qualifies without them) and none on the built-in risk and self-modify lists, which can't be removed; and never a change to the factory itself. It only approves; the babysitter lands the merge. Turning it on, raising a limit or widening allowPaths is a loosening an org admin approves; it counts for an item only while it is on in both the version the item pinned and the current one. A project is held automatically after an incident, a revert, red CI after one of its merges or a person's 'should not have merged'; only an org admin lifts a hold. Small items never qualify (triage, an agent, ties their criteria). On the factory's own repository it covers at most docs/design, whatever allowPaths says.",
      ),
    maxChangedLines: z
      .number()
      .int()
      .min(1)
      .max(5_000)
      .default(200)
      .describe("Most lines added plus removed, by GitHub's compare with the default branch."),
    maxFiles: z.number().int().min(1).max(200).default(10).describe("Most files changed."),
    maxPerDay: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Most merges auto-approved in one project in a day (UTC), across its workflows."),
    /**
     * The places an unattended change may touch (review of #152): every changed path must match one.
     * No default: empty means nothing qualifies, and the setting can't be turned on without them.
     */
    allowPaths: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          // A place, not "anywhere" (review of #152): at least one segment with no wildcard.
          .refine(
            (g) => g.split("/").some((seg) => seg.length > 0 && !/[*?]/.test(seg)),
            "an allowPaths entry names a place (src/components/**), not a bare wildcard",
          ),
      )
      .max(100)
      .default([])
      .describe(
        "Globs of the paths an auto-approved change may touch (src/components/**, docs/**): every path a change touches must match one. Required to turn auto-approval on; nothing qualifies without them.",
      ),
    /** Globs no auto-approved change may touch, on top of the floors. */
    forbiddenPaths: z
      .array(z.string().min(1).max(200))
      .max(100)
      .default([])
      .describe("Paths no auto-approved change may touch, on top of the built-in lists."),
    /** Globs that make a change risky, on top of `RISK_PATHS`. */
    riskPaths: z
      .array(z.string().min(1).max(200))
      .max(100)
      .default([])
      .describe("Paths that make a change risky, on top of the built-in risk paths."),
  })
  .strict()
  .refine((s) => !s.enabled || s.allowPaths.length > 0, {
    message:
      "auto-approval needs allowPaths: the places an unattended change may touch (src/components/**, docs/**). Nothing qualifies without them.",
    path: ["allowPaths"],
  });
export type AutoApproveSettings = z.infer<typeof autoApproveSettings>;
export const AUTO_APPROVE_OFF: AutoApproveSettings = autoApproveSettings.parse({});

/**
 * The risk floor in code (ADR 0515 §4): migrations, auth, billing, secrets and environment files, CI
 * and repository settings, factory policy. A workflow's lists only add to it. Lock files are risky
 * only without a matching manifest change (`lockWithoutManifest`).
 */
export const RISK_PATHS = [
  // Migrations and schemas, wherever they live.
  "**/migrations/**",
  "**/*.sql",
  "**/schema.*",
  "**/*.schema.*",
  "**/schemas/**",
  "**/*.prisma",
  "**/*.graphql",
  "**/*.dbml",
  // Auth, sessions, secrets and permissions, by any of their names.
  "**/auth/**",
  "**/*auth*",
  "**/*login*",
  "**/*session*",
  "**/*oauth*",
  "**/*token*",
  "**/*password*",
  "**/*permission*",
  "**/*secret*",
  "**/*crypto*",
  "**/*credential*",
  // Billing and money.
  "**/billing/**",
  "**/payments/**",
  "**/*billing*",
  "**/*payment*",
  "**/*stripe*",
  "**/*invoice*",
  "**/*subscription*",
  "**/*pricing*",
  // Secrets and environment.
  "**/.env*",
  "**/.dev.vars*",
  "**/wrangler.*",
  // CI, repository settings and infrastructure.
  ".github/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  "**/Dockerfile*",
  "**/docker-compose*",
  "**/*.tf",
  "**/*.tfvars",
  "infra/**",
  "terraform/**",
  "k8s/**",
  "helm/**",
  // Submodules and what the factory's agents read as instructions.
  ".gitmodules",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/SKILL.md",
  ".claude/**",
  ".cursor/**",
  ".kim/**",
  // The evals that judge the factory, and the factory's own policy.
  "evals/**",
  ".factory/**",
  // Package and config surfaces: what is built, bundled and resolved, wherever it lives (review
  // of #152: an `exports` map or a `paths` mapping can swap in other code).
  "**/package.json",
  "**/tsconfig*",
  "**/jsconfig*",
  "**/*.config.*",
  "**/turbo.json",
  "**/biome.json",
  "**/pnpm-workspace.yaml",
  "**/.npmrc",
  "**/.nvmrc",
  "**/Makefile",
  "**/justfile",
  // Release and build scripts.
  "**/scripts/**",
  "**/release*",
  // Native code and its build (a key helper, a desktop shell).
  "**/*.swift",
  "**/*.m",
  "**/*.mm",
  "**/*.entitlements",
  "**/*.plist",
  // Manifests in every ecosystem (review of #152: what installs and runs).
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/setup.py",
  "**/setup.cfg",
  "**/Pipfile",
  "**/go.mod",
  "**/Cargo.toml",
  "**/Gemfile",
  "**/*.gemspec",
  "**/build.gradle*",
  "**/settings.gradle*",
  "**/pom.xml",
  "**/composer.json",
  "**/*.csproj",
  // Build scripts by any name.
  "**/build.*",
  "**/esbuild*",
  "**/rollup*",
  "**/webpack*",
  "**/gulpfile*",
  "**/Gruntfile*",
  // CI, deploy and hooks, wherever they're configured.
  "**/Jenkinsfile",
  "**/azure-pipelines*",
  ".buildkite/**",
  "**/bitbucket-pipelines*",
  "**/.travis.yml",
  "**/.drone.yml",
  "**/appveyor.yml",
  "**/vercel.json",
  "**/netlify.toml",
  "**/fly.toml",
  "**/Procfile",
  "**/app.yaml",
  "**/render.yaml",
  "**/railway.json",
  "**/serverless.*",
  ".husky/**",
  ".githooks/**",
  "**/.pre-commit-config.yaml",
  "**/lefthook*",
  // Instructions other agents read.
  "**/.cursorrules",
  "**/GEMINI.md",
  "**/.windsurfrules",
  "**/copilot-instructions.md",
  "**/.aider*",
  // Lock files: what installs, whatever the manifest says.
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/go.sum",
] as const;

/**
 * On the factory's own repository auto-approval is default-deny (review of #152, ADR 0515 amended):
 * a change qualifies only when every path it touches is on this list. Widening it takes an ADR.
 */
export const FACTORY_SOURCE_ALLOW = ["docs/design/**"] as const;

/**
 * The structural floor (review of #152): what is risky by its shape, at any depth and in any case,
 * so a new ecosystem's file doesn't slip through a list. Returns why, or null.
 */
export function structuralRisk(path: string): string | null {
  // A path with a control character or a line break isn't matched by globs as a person reads it.
  if (/\p{Cc}|\p{Zl}|\p{Zp}/u.test(path)) return "a path with control characters";
  const segs = path.split("/");
  const lower = segs.map((x) => x.toLowerCase());
  const base = lower.at(-1) ?? "";
  // (a) any hidden file or directory, at any depth (.github, .claude, .husky, .devcontainer…).
  if (segs.some((x) => x.startsWith("."))) return "a hidden file or directory";
  // (b) lock files, by shape.
  if (
    /\.lockb?$/.test(base) ||
    /lock.*\.(json|ya?ml|toml)$/.test(base) ||
    /-lock\./.test(base) ||
    base.includes("shrinkwrap")
  )
    return "a lock file";
  // (c) manifests, build files, setup files and task runners, by name at any depth.
  if (MANIFEST_NAMES.has(base) || MANIFEST_SHAPES.some((re) => re.test(base)))
    return "a manifest, build or setup file";
  // (d) migrations and hooks wherever they live.
  if (lower.some((x) => x === "migrations" || x === "migrate" || x === "hooks"))
    return "migrations or hooks";
  if (lower.includes("alembic") && lower.includes("versions")) return "migrations";
  // (e) owners and agent instruction files.
  if (
    base === "codeowners" ||
    /^agents.*\.md$/.test(base) ||
    /^claude.*\.md$/.test(base) ||
    base === "gemini.md" ||
    base === "opencode.json" ||
    base.endsWith(".rules")
  )
    return "an owners or agent instruction file";
  return null;
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "deno.json",
  "deno.jsonc",
  "bunfig.toml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "pipfile",
  "conftest.py",
  "go.mod",
  "go.sum",
  "go.work",
  "cargo.toml",
  "gemfile",
  "rakefile",
  "mix.exs",
  "podfile",
  "pubspec.yaml",
  "pom.xml",
  "gradle.properties",
  "gradlew",
  "gradlew.bat",
  "composer.json",
  "makefile",
  "justfile",
  "taskfile.yml",
  "taskfile.yaml",
  "procfile",
  "jenkinsfile",
  "dockerfile",
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "app.yaml",
  "render.yaml",
  "railway.json",
  "codeowners",
]);
const MANIFEST_SHAPES = [
  /^requirements.*\.txt$/,
  /\.gemspec$/,
  /^build\.gradle/,
  /^settings\.gradle/,
  /\.(cs|fs|vb)proj$/,
  /^gradle-wrapper\./,
  /^tsconfig.*\.json$/,
  /^jsconfig.*\.json$/,
  /\.config\.[cm]?[jt]s$/,
  /\.config\.json$/,
  /^(vitest|jest|playwright)\.setup\./,
  /^build\./,
  /^esbuild/,
  /^rollup/,
  /^webpack/,
  /^gulpfile/,
  /^gruntfile/,
  /^dockerfile/,
  /^docker-compose/,
  /^azure-pipelines/,
  /^bitbucket-pipelines/,
  /^serverless\./,
  /^wrangler\./,
  /\.tf(vars)?$/,
];

/** Generated files: what made them isn't in the diff, so they aren't low risk. */
export const GENERATED_PATHS = [
  "**/*.gen.*",
  "**/generated/**",
  "**/__generated__/**",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
  "**/worker-configuration.d.ts",
] as const;

/**
 * Changes to the factory itself (ADR 0515 §4–5, decided by the owner): excluded from auto-approval in
 * every workflow on every repository. No setting removes a path from this list.
 */
export const SELF_MODIFY_PATHS = [
  // By directory, so nothing that enforces policy is left out by name (review of #152): the import
  // graph from the gate and verify entry points stays inside this list (auto-approve.test.ts).
  "packages/core/src/**",
  "packages/db/**",
  "packages/runner-contract/**",
  "packages/runner-local/**",
  "packages/harness-claude/**",
  "packages/connector-*/**",
  "packages/config/**",
  "apps/engine/src/**",
  "apps/app/src/**",
  "apps/desktop/src/bun/**",
  "local/runner-host/**",
  "presets/**",
  "scripts/deploy/**",
  "scripts/checks/**",
  ".factory/**",
  ".github/**",
  "**/wrangler.*",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
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
    /**
     * Every acceptance criterion proven by a check that ran on this SHA, counting only ties a
     * person approved (the spec's): `criteriaProven` (as #146's `everyCriterionProven`).
     */
    criteriaProven: boolean;
    /** A person, not the adjudicator, approved the spec whose ties count (review of #152). */
    specByPerson: boolean;
    /** The proof was weakened (a check changed in the same diff, ADR 0501). */
    weakened: boolean;
    testsIntact: boolean | null;
  } | null;
  /** The adjudicator: active for merge on this project, earned, and its verdict on this SHA. */
  adjudicator: { active: boolean; eligible: boolean; approved: boolean } | null;
  /**
   * GitHub's compare of the default branch with the head. `unreadable`: GitHub gave no diff for it
   * (binary, too large, a submodule): not low risk.
   */
  changes:
    | {
        path: string;
        changes: number | null;
        unreadable?: boolean;
        submodule?: boolean;
        /** The old side of a rename (not a file GitHub counts on its own). */
        renamedFrom?: boolean;
      }[]
    | null;
  /** How many files GitHub says the change touches (the PR's `changed_files`); must match. */
  reportedFiles?: number | null;
  /** Paths whose file mode is a symlink or a submodule, or changed between base and head. */
  modeChanges?: string[];
  /** The repository is the factory's own source: default-deny (`FACTORY_SOURCE_ALLOW`). */
  factorySource?: boolean;
  /** The item's Workflow version has dark factory mode (the babysitter re-checks it). */
  versionSupports?: boolean;
  /** Merges auto-approved in the project today (UTC), before this one. */
  today?: number;
  /** The project's hold (ADR 0515 §7), if set. */
  hold: string | null;
  /** The merge would change the factory's own config (the gate's `touchesFactoryConfig`). */
  touchesFactoryConfig: boolean;
}

export type AutoApproveCondition =
  | "enabled"
  | "hold"
  | "version"
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
  add(
    "version",
    facts.versionSupports === true,
    facts.versionSupports === true
      ? "the item's Workflow version has dark factory mode"
      : "the item's Workflow version has no dark factory mode (no babysitter re-check)",
  );
  const p = facts.packet;
  add(
    "checks",
    !!p &&
      p.verdict === "pass" &&
      p.ci === "success" &&
      p.criteriaProven &&
      p.specByPerson &&
      !p.weakened,
    !p
      ? "no review packet on this commit"
      : p.verdict !== "pass"
        ? "the review packet didn't pass"
        : p.ci !== "success"
          ? `CI on this commit is ${p.ci ?? "unknown"}`
          : p.weakened
            ? "the proof was weakened: a check changed in the same diff"
            : !p.specByPerson
              ? "the spec wasn't approved by a person (the adjudicator's approval doesn't count here)"
              : !p.criteriaProven
                ? "not every criterion is proven by a check a person tied to it (small items never are: triage ties theirs)"
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
  // Every path inside allowPaths (and inside the other version's, after `stricterAutoApprove`).
  const allow = [setting.allowPaths, ...((setting as { alsoAllow?: string[][] }).alsoAllow ?? [])];
  const outside = paths.filter((p) => allow.some((list) => !list.some((g) => globMatch(g, p))));
  const today = facts.today ?? 0;
  // At least one file, and exactly as many as GitHub says the change touches (fail closed).
  const own = (changes ?? []).filter((c) => !c.renamedFrom).length;
  const counted = !!changes && own > 0 && facts.reportedFiles === own;

  const self = matching(SELF_MODIFY_PATHS, paths);
  const risky = [
    ...matching([...RISK_PATHS, ...GENERATED_PATHS, ...setting.riskPaths], paths),
    ...(changes ?? []).filter((c) => c.unreadable).map((c) => `${c.path} (no readable diff)`),
    ...(changes ?? []).filter((c) => c.submodule).map((c) => `${c.path} (a submodule bump)`),
    ...paths.flatMap((x) => {
      const why = structuralRisk(x);
      return why ? [`${x.replace(/\p{Cc}/gu, "?")} (${why})`] : [];
    }),
    ...(facts.modeChanges ?? []).map((x) => `${x} (a symlink, a submodule or a mode change)`),
    // The factory's own repository: anything off the allow-list.
    ...(facts.factorySource
      ? paths.filter((x) => !FACTORY_SOURCE_ALLOW.some((g) => globMatch(g, x)))
      : []),
  ];
  add(
    "risk",
    !!changes && !facts.touchesFactoryConfig && self.length === 0 && risky.length === 0,
    !changes
      ? "the change couldn't be read from GitHub"
      : facts.touchesFactoryConfig || self.length
        ? `a change to the factory itself${self.length ? `: ${self.slice(0, 5).join(", ")}` : ""}`
        : facts.factorySource && risky.length
          ? `the factory's own repository: only ${FACTORY_SOURCE_ALLOW.join(" and ")} are auto-approved (${[...new Set(risky)].slice(0, 3).join(", ")})`
          : risky.length
            ? `touches a risk path: ${[...new Set(risky)].slice(0, 5).join(", ")}`
            : "low risk",
  );
  add(
    "limits",
    !!changes &&
      counted &&
      changes.length <= setting.maxFiles &&
      lines !== null &&
      lines <= setting.maxChangedLines &&
      forbidden.length === 0 &&
      outside.length === 0 &&
      today < setting.maxPerDay,
    !changes
      ? "the change couldn't be read from GitHub"
      : !counted
        ? own === 0
          ? "GitHub lists no files for this change"
          : `GitHub's file count (${facts.reportedFiles ?? "missing"}) doesn't match the ${own} files compared`
        : today >= setting.maxPerDay
          ? `${today} merges were auto-approved in this project today (the limit is ${setting.maxPerDay})`
          : changes.length > setting.maxFiles
            ? `${changes.length} files changed (the limit is ${setting.maxFiles})`
            : lines === null || !Number.isFinite(lines)
              ? "a file's changed lines couldn't be counted"
              : lines > setting.maxChangedLines
                ? `${lines} lines changed (the limit is ${setting.maxChangedLines})`
                : forbidden.length
                  ? `touches a forbidden path: ${forbidden.slice(0, 5).join(", ")}`
                  : outside.length
                    ? `outside allowPaths: ${outside.slice(0, 5).join(", ")}`
                    : "inside the size and path limits",
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
  for (const key of ["maxChangedLines", "maxFiles", "maxPerDay"] as const) {
    if (before[key] === after[key]) continue;
    out.push({
      path: `${path}.${key}`,
      class: after[key] > before[key] ? "loosens" : "tightens",
      summary: `Auto-approval ${key === "maxFiles" ? "file" : key === "maxPerDay" ? "daily" : "changed-line"} limit ${before[key]} → ${after[key]}.`,
    });
  }
  {
    const widened = after.allowPaths.filter((x) => !before.allowPaths.includes(x));
    const narrowed = before.allowPaths.filter((x) => !after.allowPaths.includes(x));
    if (widened.length)
      out.push({
        path: `${path}.allowPaths`,
        class: "loosens",
        summary: `Auto-approved changes may also touch: ${widened.join(", ")}.`,
      });
    if (narrowed.length)
      out.push({
        path: `${path}.allowPaths`,
        class: "tightens",
        summary: `Auto-approved changes may no longer touch: ${narrowed.join(", ")}.`,
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

/**
 * The stricter of two settings (the version an item pinned and the org's current one): on only if
 * on in both, the lower limits, every path of either (review of #152).
 */
export function stricterAutoApprove(
  a: AutoApproveSettings,
  b: AutoApproveSettings,
): AutoApproveSettings {
  return {
    enabled: a.enabled && b.enabled,
    maxChangedLines: Math.min(a.maxChangedLines, b.maxChangedLines),
    maxFiles: Math.min(a.maxFiles, b.maxFiles),
    maxPerDay: Math.min(a.maxPerDay, b.maxPerDay),
    forbiddenPaths: [...new Set([...a.forbiddenPaths, ...b.forbiddenPaths])],
    riskPaths: [...new Set([...a.riskPaths, ...b.riskPaths])],
    // A path must be inside both versions' allowPaths.
    allowPaths: a.allowPaths,
    alsoAllow: [b.allowPaths, ...((a as { alsoAllow?: string[][] }).alsoAllow ?? [])],
  } as AutoApproveSettings;
}

/**
 * ADR 0515's "every acceptance criterion is proven by a check that ran on the head SHA", from a
 * packet's stored proof: only ties a person approved (`linkedBy: "spec"`, never the reviewer's or
 * triage's) count, as PR #146's `everyCriterionProven`; no criteria is false. Small items never
 * qualify: their criteria come from triage, an agent.
 */
export function criteriaProven(sections: Record<string, unknown>): boolean {
  const proof = sections.proof;
  if (!Array.isArray(proof) || proof.length === 0) return false;
  // #146's own rule (only a person-approved tie, never triage's), and the spec's links only.
  return (
    everyCriterionProven(proof as CriterionProof[]) &&
    proof.every((p) => (p as { linkedBy?: unknown }).linkedBy === "spec")
  );
}
