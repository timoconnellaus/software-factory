// Tests intact (ADR 0450, spec 51): does a diff weaken the tests the build is judged by? Read from
// GitHub's compare of the default branch with the head SHA, with each file's patch, never from the
// runner or an agent. A finding is never judged by an agent: it goes on the review packet for that
// SHA and to a person, and it blocks the check-only auto-merge (ADR 0230).
//
// Pure functions. The patterns are heuristics for TypeScript, JavaScript and some Python; they only
// add findings, and a test or gate file whose patch GitHub didn't return is a finding of its own.
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
  findings: TestFinding[];
}

/** At most this many findings are kept; the count says how many there were. */
export const MAX_FINDINGS = 100;

const TEST_FILE =
  /(^|\/)(__tests__|__test__|tests?|spec|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;

/** Whether a path is a test file. */
export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path);
}

const GATE_FILES: { test: (p: string) => boolean; what: string }[] = [
  { test: (p) => p === ".factory" || p.startsWith(".factory/"), what: "the factory's config" },
  { test: (p) => p.startsWith(".github/workflows/"), what: "a CI workflow" },
  {
    test: (p) =>
      /(^|\/)(vitest|vite|jest|playwright|karma|cypress)\.(config|workspace)\.[cm]?[jt]s$/.test(
        p,
      ) || /(^|\/)vitest\.workspace\.(json|[cm]?[jt]s)$/.test(p),
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
      /(^|\/)eslint\.config\.[cm]?[jt]s$/.test(p),
    what: "lint config",
  },
  { test: (p) => /(^|\/)turbo\.json$/.test(p), what: "the task pipeline that runs the checks" },
];

/** What kind of gate file a path is, or null. */
export function gateFile(path: string): string | null {
  return GATE_FILES.find((g) => g.test(path))?.what ?? null;
}

const CASE = /^\s*(?:it|test|describe|suite|context)(?:\.\w+)*\s*\(\s*(['"`])(.*?)\1/;
const SKIPPED: RegExp[] = [
  /\b(?:it|test|describe|suite|context|bench)\s*\.\s*(skip|only|todo|fixme|skipIf|runIf)\b/,
  /(^|[^\w.])(xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(/,
  /@pytest\.mark\.(skip|skipif|xfail)\b|@unittest\.(skip|expectedFailure)\b/,
];
const COMMENTED_CASE = /^\s*(?:\/\/+|\/?\*+|#)\s*(?:it|test|describe)(?:\.\w+)*\s*\(/;
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
/** Source files a suppression comment or cast means something in. */
const CODE = /\.([cm]?[jt]sx?|py|go|rs|svelte|vue)$/;
/** Files a coverage or threshold number lives in (besides test and gate files). */
const THRESHOLD_FILE =
  /(^|\/)(package\.json|pyproject\.toml|setup\.cfg|\.coveragerc|codecov\.ya?ml|[^/]*config[^/]*)$/;
const STRICT_OFF =
  /"(strict|noImplicitAny|strictNullChecks|noUncheckedIndexedAccess|exactOptionalPropertyTypes|noImplicitReturns)"\s*:\s*false/;
/** `key: 80` or `"key": 80` or `key = 80`, for keys that name a bar a test run must clear. */
const THRESHOLD =
  /["']?((?:lines|branches|functions|statements|threshold\w*|coverage\w*|min\w*|fail_under|failUnder))["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i;

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

  // Test titles added anywhere in the diff: a case removed here and added back elsewhere moved.
  const addedTitles = new Set<string>();
  for (const f of files) {
    if (f.patch === undefined) continue;
    for (const l of patchLines(f.patch)) {
      // A case commented out is its own finding, not also a removal.
      const m = l.sign === "+" ? CASE.exec(l.text.replace(/^\s*(?:\/\/+|\/?\*+|#)/, "")) : null;
      if (m?.[2]) addedTitles.add(m[2]);
    }
  }

  for (const f of files) {
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

    if (f.patch === undefined) {
      if ((test || gate) && f.status !== "removed" && f.status !== "unchanged") {
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

    const lines = patchLines(f.patch);
    const code = CODE.test(f.path);
    const thresholds = test || gate !== null || THRESHOLD_FILE.test(f.path);
    const removedThresholds = new Map<string, { value: number; line: number }>();
    for (const l of lines) {
      if (l.sign === "-") {
        if (test) {
          const m = CASE.exec(l.text);
          if (m?.[2] !== undefined && !addedTitles.has(m[2])) {
            add({
              kind: "test-removed",
              path: f.path,
              line: l.line,
              text: clip(l.text),
              message: `a test was removed: "${clip(m[2])}"`,
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
  }

  return {
    headSha,
    intact: findings.length === 0,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

/** One line per finding, for `factory/verify`'s summary and the Workflow's notes. */
export function testFindingLines(findings: readonly TestFinding[]): string[] {
  return findings.map((f) => `${f.message}${f.line ? ` (${f.path}:${f.line})` : ""}`);
}
