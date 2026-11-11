// The check-only auto-merge rule (ADR 0230, amending ADR 0008): a factory incident's fix may merge
// without a person only when, by GitHub's compare (never the runner's word), it ADDS files and
// nothing else, all of them new checks under `.factory/checks/` or regression cases under
// `evals/regressions/`, with at least one regression case. Anything else, including any change to
// `.factory/policy.json` or to an existing check, goes to the merge gate as usual.
import type { ChangedFile } from "../services.ts";

export const CHECK_ONLY_PREFIXES = [".factory/checks/", "evals/regressions/"] as const;
export const REGRESSION_PREFIX = "evals/regressions/";
/** GitHub's compare lists at most 300 files; a compare that big is never check-only. */
export const MAX_COMPARE_FILES = 300;

export type CheckOnlyVerdict = { ok: true } | { ok: false; reason: string };

export function checkOnlyDiff(files: readonly ChangedFile[]): CheckOnlyVerdict {
  if (files.length === 0) return { ok: false, reason: "the diff is empty" };
  if (files.length >= MAX_COMPARE_FILES) return { ok: false, reason: "the diff is too large" };
  for (const f of files) {
    if (f.status !== "added") {
      return { ok: false, reason: `${f.path} is ${f.status}, and only added files may auto-merge` };
    }
    const safe =
      !f.path.split("/").some((part) => part === ".." || part === "." || part === "") &&
      CHECK_ONLY_PREFIXES.some(
        (prefix) => f.path.startsWith(prefix) && f.path.length > prefix.length,
      );
    if (!safe) {
      return {
        ok: false,
        reason: `${f.path} is outside ${CHECK_ONLY_PREFIXES.join(" and ")}`,
      };
    }
  }
  if (!files.some((f) => f.path.startsWith(REGRESSION_PREFIX))) {
    return { ok: false, reason: `no regression case under ${REGRESSION_PREFIX}` };
  }
  return { ok: true };
}
