// Tests intact (ADR 0500, spec 51): does a diff weaken the tests the build is judged by? Read from
// GitHub's compare of the default branch with the head SHA, with each file's patch, never from the
// runner or an agent. A finding is never judged by an agent: it goes on the review packet for that
// SHA and to a person, and it blocks the check-only auto-merge (ADR 0230).
//
// Pure functions. The patterns are heuristics for TypeScript, JavaScript and some Python; they only
// add findings, and anything the guard couldn't read (a truncated compare, a code, test or gate file
// without its patch) is a finding of its own: unknown never reads as intact.
//
// What it does NOT see: weakening inside a test that keeps its shape, such as `expect(true)`, an
// emptied body or `if (false)`. "No findings" means these checks found nothing, not that the tests
// are as strong as before.
import type { ChangedFile } from "../services.ts";

export const TEST_FINDING_KINDS = [
  "test-deleted",
  "test-removed",
  "test-skipped",
  "test-commented-out",
  "suppression",
  "threshold-lowered",
  "gate-file",
  "unreadable",
] as const;
export type TestFindingKind = (typeof TEST_FINDING_KINDS)[number];

export interface TestFinding {
  kind: TestFindingKind;
  path: string;
  /** The line in the head's version of the file (added lines) or the base's (removed lines). */
  line: number | null;
  /** The line's text, trimmed and clipped; null for whole-file findings. */
  text: string | null;
  /** One sentence for the packet. */
  message: string;
}

export interface TestsIntact {
  headSha: string;
  intact: boolean;
  /** The first MAX_FINDINGS findings. */
  findings: TestFinding[];
  /** How many there were in all. */
  total: number;
}

/** At most this many findings are kept; `total` says how many there were. */
export const MAX_FINDINGS = 100;

/** GitHub's compare lists at most this many files; a compare that reaches it may be cut short. */
export const COMPARE_FILE_LIMIT = 300;

const TEST_FILE =
  /(^|\/)(__tests__|__test__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;

/** Whether a path is a test file. */
export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Directories a test runner's usual globs leave out, or that say the test is parked. */
const PARKED =
  /(^|\/)(disabled|skip|skipped|parked|archive|archived|old|deprecated|spikes?|fixtures?|__fixtures__|node_modules|tmp|\.[^/]+)\//i;

/** Whether a test path looks parked where the test run won't pick it up. */
export function isParkedPath(path: string): boolean {
  return PARKED.test(path);
}

const GATE_FILES: { test: (p: string) => boolean; what: string }[] = [
  { test: (p) => p === ".factory" || p.startsWith(".factory/"), what: "the factory's config" },
  { test: (p) => p.startsWith(".github/workflows/"), what: "a CI workflow" },
  { test: (p) => p.startsWith(".github/actions/"), what: "a CI action" },
  {
    // vitest.config.ts, vitest.e2e.config.ts, vitest.shared.ts, jest.setup.js, vite.config.mts…
    test: (p) =>
      /(^|\/)(vitest|jest|playwright|karma|cypress|mocha|ava)[\w.-]*\.([cm]?[jt]s|json|ya?ml)$/.test(
        p,
      ) ||
      /(^|\/)vite\.config[\w.-]*\.[cm]?[jt]s$/.test(p) ||
      /(^|\/)\.mocharc(\.[a-z]+)?$/.test(p),
    what: "test config",
  },
  {
    test: (p) =>
      /(^|\/)(\.c8rc|\.nycrc)(\.json)?$/.test(p) ||
      /(^|\/)(pytest\.ini|conftest\.py|\.coveragerc|setup\.cfg)$/.test(p),
    what: "test config",
  },
  {
    test: (p) =>
      /(^|\/)biome\.jsonc?$/.test(p) ||
      /(^|\/)\.eslintrc(\.[a-z]+)?$/.test(p) ||
      /(^|\/)eslint\.config\.[cm]?[jt]s$/.test(p) ||
      /(^|\/)\.(eslintignore|biomeignore)$/.test(p),
    what: "lint config",
  },
  { test: (p) => /(^|\/)turbo\.json$/.test(p), what: "the task pipeline that runs the checks" },
  {
    // What install runs and resolves (third review, 4): allowed build scripts, overrides, hooks.
    test: (p) =>
      /(^|\/)(pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.c?js|\.yarnrc(\.yml)?|bunfig\.toml)$/.test(
        p,
      ),
    what: "the package manager's config (what install runs and resolves)",
  },
];

/** What kind of gate file a path is, or null. */
export function gateFile(path: string): string | null {
  return GATE_FILES.find((g) => g.test(path))?.what ?? null;
}

const CASE = /^\s*(?:it|test|describe|suite|context)(?:\.\w+)*\s*\(\s*(['"`])(.*?)\1/;
/** A case whose title is on the next line: `it(` alone. */
const CASE_OPEN = /^\s*(?:it|test|describe|suite|context)(?:\.\w+)*\s*\(\s*$/;
const TITLE = /^\s*(['"`])(.*?)\1/;
const MODIFIERS = "skip|only|todo|fixme|fails|failing|skipIf|runIf";
const SKIPPED: RegExp[] = [
  // it.skip, test.only, it.concurrent.skip, describe.skipIf(…), test.fails
  new RegExp(
    `\\b(?:it|test|describe|suite|context|bench)(?:\\s*\\.\\s*\\w+)*?\\s*\\.\\s*(${MODIFIERS})\\b`,
  ),
  // it.each(…).skip, describe.each`…`.only
  new RegExp(`[)\`]\\s*\\.\\s*(${MODIFIERS})\\b`),
  /(^|[^\w.])(xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(/,
  // ctx.skip(), this.skip(), t.skip() inside a body
  /\b(?:ctx|context|this|t|test)\s*\.\s*skip\s*\(/,
  /@pytest\.mark\.(skip|skipif|xfail)\b|@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b|pytest\.skip\(/,
];
const COMMENTED_CASE = /^\s*(?:\/\/+|\/?\*+|#)\s*(?:it|test|describe)(?:\.\w+)*\s*\(/;
/** A block comment opened or closed: it can hide whole cases between the two lines. */
const BLOCK_COMMENT = /^\s*\/\*(?!\*?\s*@)|\*\/\s*$/;
const SUPPRESSIONS: { re: RegExp; what: string }[] = [
  { re: /biome-ignore/, what: "a `biome-ignore`" },
  { re: /@ts-ignore\b/, what: "a `@ts-ignore`" },
  { re: /@ts-expect-error\b/, what: "a `@ts-expect-error`" },
  { re: /@ts-nocheck\b/, what: "a `@ts-nocheck`" },
  { re: /eslint-disable/, what: "an `eslint-disable`" },
  { re: /#\s*type:\s*ignore\b/, what: "a `# type: ignore`" },
  { re: /#\s*noqa\b/, what: "a `# noqa`" },
  { re: /\bas\s+any\b|<any>\s*[\w(]/, what: "an `any` cast" },
];
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
/** Source files a suppression comment or cast means something in. */
const CODE = /\.([cm]?[jt]sx?|py|go|rs|svelte|vue)$/;
/** Files a coverage or threshold number lives in (besides test and gate files). */
const THRESHOLD_FILE =
  /(^|\/)(package\.json|pyproject\.toml|setup\.cfg|\.coveragerc|codecov\.ya?ml|[^/]*(vitest|jest|coverage|c8|nyc)[^/]*)$/;
/** In package.json: the scripts that run checks, and test-runner config keys. */
const PACKAGE_GATE =
  /^\s*"(test|tests|lint|typecheck|check|checks|ci|verify|coverage|e2e)(:[\w:.-]*)?"\s*:|^\s*"(vitest|jest|c8|nyc|ava|mocha|biome|eslintConfig)"\s*:/;
/**
 * In package.json, what install itself runs or resolves (third review, 4): lifecycle scripts, the
 * `scripts` block, the package manager and its overrides and allowed build scripts.
 */
const PACKAGE_INSTALL =
  /^\s*"((pre|post)?install|prepare|(pre|post)prepare|prepublish(Only)?|(pre|post)pack|scripts|packageManager|overrides|resolutions|pnpm|patchedDependencies|onlyBuiltDependencies|neverBuiltDependencies|trustedDependencies)"\s*:/;
/**
 * In package.json, any other script: a `"name": "command"` line whose value isn't a version range
 * (a dependency) or a path, and whose key isn't the package's own metadata.
 */
const PACKAGE_SCRIPT_LINE = /^\s*"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/;
const NOT_A_SCRIPT_KEY =
  /^(name|version|description|main|module|browser|types|typings|type|license|author|homepage|url|email|directory|private|sideEffects|engines|node|unpkg|jsdelivr|funding|access|registry|tag)$/;
const VERSION_LIKE =
  /^(\^|~|>|<|=|\*|\d|v\d|x$|latest$|next$|workspace:|catalog:|npm:|file:|link:|portal:|patch:|git|github:|https?:|\.{0,2}\/)/;

function scriptLike(text: string): boolean {
  const m = PACKAGE_SCRIPT_LINE.exec(text);
  if (!m?.[1] || m[2] === undefined) return false;
  const [key, value] = [m[1], m[2].trim()];
  if (key.startsWith(".") || key.startsWith("/") || NOT_A_SCRIPT_KEY.test(key)) return false;
  return value !== "" && !VERSION_LIKE.test(value) && /\s|&&|\||;/.test(value);
}

/** Lockfiles, and the test tooling whose resolution in one decides what the checks run. */
const LOCKFILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/;
const TEST_TOOLING =
  /(^|[\s'"/@])(vitest|@vitest\/[\w-]+|jest|@jest\/[\w-]+|ts-jest|mocha|ava|c8|nyc|playwright|@playwright\/test|cypress|typescript|tsx|ts-node|@biomejs\/[\w-]+|eslint|@cloudflare\/vitest-pool-workers|vite|esbuild|turbo)@/;
/** In tsconfig: what the compiler (and so typecheck) looks at. */
const TSCONFIG_SCOPE = /^\s*"(include|exclude|files|references)"\s*:/;
const STRICT_OFF =
  /"(strict|noImplicitAny|strictNullChecks|noUncheckedIndexedAccess|exactOptionalPropertyTypes|noImplicitReturns)"\s*:\s*false/;
/** `key: 80` or `"key": 80` or `key = 80`, for the keys that name a coverage bar. */
const THRESHOLD =
  /["']?\b(lines|branches|functions|statements|thresholds?|coverageThreshold|minCoverage|min_coverage|minimumCoverage|fail_under|failUnder|fail-under|perFile)["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i;

interface PatchLine {
  sign: "+" | "-";
  text: string;
  line: number;
}

/** The added and removed lines of a unified diff patch, with their line numbers. */
export function patchLines(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      out.push({ sign: "+", text: raw.slice(1), line: newLine++ });
    } else if (raw.startsWith("-")) {
      out.push({ sign: "-", text: raw.slice(1), line: oldLine++ });
    } else {
      oldLine++;
      newLine++;
    }
  }
  return out;
}

const clip = (text: string) => {
  const t = text.trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};

/**
 * The findings for one compare. `files` must carry `patch` where GitHub returned one; a test or
 * gate file without one (and not simply added or removed) is reported as unreadable.
 */
export function testsIntact(headSha: string, files: readonly ChangedFile[]): TestsIntact {
  const findings: TestFinding[] = [];
  const add = (f: TestFinding) => findings.push(f);

  // A compare GitHub may have cut short, or one with nothing in it, can't say anything is intact.
  if (files.length === 0) {
    add({
      kind: "unreadable",
      path: "",
      line: null,
      text: null,
      message: "GitHub's compare listed no changed files, so nothing could be checked",
    });
  } else if (files.length >= COMPARE_FILE_LIMIT) {
    add({
      kind: "unreadable",
      path: "",
      line: null,
      text: null,
      message: `the diff lists ${files.length} files, GitHub's limit: files past it weren't checked, so check the rest by hand`,
    });
  }

  for (const f of files) {
    const lines = f.patch === undefined ? [] : patchLines(f.patch);
    // Test titles added back in this file: a case removed and re-added here (an edit) isn't gone.
    const addedTitles = new Set<string>();
    for (const [i, l] of lines.entries()) {
      if (l.sign !== "+") continue;
      // A case commented out is its own finding, not also a removal.
      const title = caseTitle(l.text.replace(/^\s*(?:\/\/+|\/?\*+|#)/, ""), lines[i + 1]);
      if (title !== null) addedTitles.add(title);
    }
    const test = isTestPath(f.path) || (f.previousPath ? isTestPath(f.previousPath) : false);
    // A new check under `.factory/checks/` only adds a failure mode (ADR 0230): not a gate edit.
    const newCheck = f.status === "added" && f.path.startsWith(".factory/checks/");
    const gate = newCheck
      ? null
      : (gateFile(f.path) ?? (f.previousPath ? gateFile(f.previousPath) : null));

    if (f.status === "removed" && isTestPath(f.path)) {
      add({
        kind: "test-deleted",
        path: f.path,
        line: null,
        text: null,
        message: `the test file \`${f.path}\` was deleted`,
      });
    } else if (
      f.status === "renamed" &&
      f.previousPath &&
      isTestPath(f.previousPath) &&
      !isTestPath(f.path)
    ) {
      add({
        kind: "test-deleted",
        path: f.previousPath,
        line: null,
        text: null,
        message: `the test file \`${f.previousPath}\` was renamed to \`${f.path}\`, which isn't a test file`,
      });
    } else if (
      f.status === "renamed" &&
      f.previousPath &&
      isTestPath(f.previousPath) &&
      isParkedPath(f.path) &&
      !isParkedPath(f.previousPath)
    ) {
      add({
        kind: "test-deleted",
        path: f.previousPath,
        line: null,
        text: null,
        message: `the test file \`${f.previousPath}\` was moved to \`${f.path}\`, where the test run may not pick it up`,
      });
    }
    if (gate) {
      add({
        kind: "gate-file",
        path: f.path,
        line: null,
        text: null,
        message: `${gate} changed: \`${f.path}\` (${f.status})`,
      });
    }

    const code = CODE.test(f.path);
    if (f.patch === undefined) {
      // A rename with no content change has no patch: nothing to read, nothing changed.
      const pureRename = f.status === "renamed" && (f.changes === undefined || f.changes === 0);
      if (
        (test ||
          gate ||
          code ||
          PACKAGE_JSON.test(f.path) ||
          TSCONFIG.test(f.path) ||
          LOCKFILE.test(f.path)) &&
        f.status !== "removed" &&
        f.status !== "unchanged" &&
        !pureRename
      ) {
        add({
          kind: "unreadable",
          path: f.path,
          line: null,
          text: null,
          message: `GitHub didn't return the change to \`${f.path}\` (too large or binary): check it by hand`,
        });
      }
      continue;
    }

    const pkg = PACKAGE_JSON.test(f.path);
    const tsconfig = TSCONFIG.test(f.path);
    let pkgGate = false;
    let installGate = false;
    let scriptGate = false;
    let scopeGate = false;
    const lockfile = LOCKFILE.test(f.path);
    const tooling = new Set<string>();
    const thresholds = test || gate !== null || THRESHOLD_FILE.test(f.path);
    const removedThresholds = new Map<string, { value: number; line: number }>();
    for (const [i, l] of lines.entries()) {
      if (pkg && !pkgGate && PACKAGE_GATE.test(l.text)) {
        pkgGate = true;
        add({
          kind: "gate-file",
          path: f.path,
          line: l.line,
          text: clip(l.text),
          message:
            "a script that runs the checks, or the test runner's config, changed in package.json",
        });
      }
      if (pkg && !installGate && PACKAGE_INSTALL.test(l.text)) {
        installGate = true;
        add({
          kind: "gate-file",
          path: f.path,
          line: l.line,
          text: clip(l.text),
          message:
            "what install runs or resolves changed in package.json (a lifecycle script, the scripts, the package manager or its overrides)",
        });
      } else if (pkg && !pkgGate && !scriptGate && scriptLike(l.text)) {
        scriptGate = true;
        add({
          kind: "gate-file",
          path: f.path,
          line: l.line,
          text: clip(l.text),
          message: "a script in package.json changed: scripts decide what the checks run",
        });
      }
      if (lockfile) {
        const m = TEST_TOOLING.exec(l.text);
        if (m?.[2]) tooling.add(m[2]);
      }
      if (tsconfig && !scopeGate && TSCONFIG_SCOPE.test(l.text)) {
        scopeGate = true;
        add({
          kind: "gate-file",
          path: f.path,
          line: l.line,
          text: clip(l.text),
          message: "what TypeScript checks changed (include, exclude, files or references)",
        });
      }
      if (l.sign === "-") {
        if (test) {
          const title = caseTitle(l.text, lines[i + 1]);
          if (title !== null && !addedTitles.has(title)) {
            add({
              kind: "test-removed",
              path: f.path,
              line: l.line,
              text: clip(l.text),
              message: `a test was removed: "${clip(title)}"`,
            });
          }
        }
        const t = thresholds ? THRESHOLD.exec(l.text) : null;
        if (t?.[1] && t[2]) {
          removedThresholds.set(t[1].toLowerCase(), { value: Number(t[2]), line: l.line });
        }
        continue;
      }
      // An added line.
      for (const s of test ? SKIPPED : []) {
        const m = s.exec(l.text);
        if (m) {
          add({
            kind: "test-skipped",
            path: f.path,
            line: l.line,
            text: clip(l.text),
            message: `a test is skipped, focused or left to do (\`${clip(m[0].replace(/^[^\w@]+/, ""))}\`)`,
          });
          break;
        }
      }
      if (test && COMMENTED_CASE.test(l.text)) {
        add({
          kind: "test-commented-out",
          path: f.path,
          line: l.line,
          text: clip(l.text),
          message: "a test case was commented out",
        });
      } else if (test && BLOCK_COMMENT.test(l.text)) {
        add({
          kind: "test-commented-out",
          path: f.path,
          line: l.line,
          text: clip(l.text),
          message: "a block comment was opened or closed in a test file: it can hide whole cases",
        });
      }
      for (const s of code ? SUPPRESSIONS : []) {
        if (s.re.test(l.text)) {
          add({
            kind: "suppression",
            path: f.path,
            line: l.line,
            text: clip(l.text),
            message: `${s.what} was added`,
          });
          break;
        }
      }
      if (TSCONFIG.test(f.path)) {
        const m = STRICT_OFF.exec(l.text);
        if (m) {
          add({
            kind: "suppression",
            path: f.path,
            line: l.line,
            text: clip(l.text),
            message: `TypeScript's \`${m[1]}\` was turned off`,
          });
        }
      }
      const t = thresholds ? THRESHOLD.exec(l.text) : null;
      if (t?.[1] && t[2]) {
        const before = removedThresholds.get(t[1].toLowerCase());
        if (before && Number(t[2]) < before.value) {
          add({
            kind: "threshold-lowered",
            path: f.path,
            line: l.line,
            text: clip(l.text),
            message: `\`${t[1]}\` was lowered from ${before.value} to ${t[2]}`,
          });
        }
      }
    }
    if (tooling.size > 0) {
      add({
        kind: "gate-file",
        path: f.path,
        line: null,
        text: null,
        message: `the lockfile changes how the test tooling resolves: ${[...tooling].sort().join(", ")}`,
      });
    }
  }

  return {
    headSha,
    intact: findings.length === 0,
    findings: findings.slice(0, MAX_FINDINGS),
    total: findings.length,
  };
}

/** A case's title from its line, or from the next one when the line is `it(` alone. */
function caseTitle(text: string, next: PatchLine | undefined): string | null {
  const m = CASE.exec(text);
  if (m?.[2] !== undefined) return m[2];
  if (CASE_OPEN.test(text) && next) {
    const t = TITLE.exec(next.text);
    if (t?.[2] !== undefined) return t[2];
  }
  return null;
}

/**
 * One line per finding, for `factory/verify`'s summary and the Workflow's notes, and a last line
 * saying how many more there were when they were cut at MAX_FINDINGS.
 */
export function testFindingLines(
  findings: readonly TestFinding[],
  total = findings.length,
): string[] {
  const lines = findings.map((f) => `${f.message}${f.line ? ` (${f.path}:${f.line})` : ""}`);
  if (total > findings.length) {
    lines.push(
      `…and ${total - findings.length} more (${total} in all; only the first ${findings.length} are kept)`,
    );
  }
  return lines;
}
