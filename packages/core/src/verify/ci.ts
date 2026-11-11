// Reading CI the cloud can trust (ADR 0037, spec 04 criterion 9): the verdict comes from GitHub's
// check runs on the head SHA, never from what a runner reports. The factory's own checks are left
// out, so `factory/verify` can never vouch for itself.
import type { CheckRunInfo } from "../services.ts";

/** The required check the factory posts from its App, bound to one head SHA (ADR 0037). */
export const VERIFY_CHECK_NAME = "factory/verify";

/** `missing`: no CI check has reported on the SHA at all, which never counts as green. */
export type CiState = "success" | "failure" | "pending" | "missing";

export interface CiCheck {
  name: string;
  status: CheckRunInfo["status"];
  conclusion: string | null;
  url: string | null;
}

export interface CiSummary {
  state: CiState;
  checks: CiCheck[];
  failing: string[];
  pending: string[];
}

const GREEN = new Set(["success", "neutral", "skipped"]);

/** Summarises the check runs on a SHA. `ownAppSlug` is the factory's App: its checks don't count. */
export function summarizeCi(runs: readonly CheckRunInfo[], ownAppSlug: string): CiSummary {
  const checks: CiCheck[] = runs
    .filter((r) => r.name !== VERIFY_CHECK_NAME && (!ownAppSlug || r.appSlug !== ownAppSlug))
    .map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.url }));
  const pending = checks.filter((c) => c.status !== "completed").map((c) => c.name);
  const failing = checks
    .filter((c) => c.status === "completed" && !GREEN.has(c.conclusion ?? ""))
    .map((c) => c.name);
  const state: CiState =
    failing.length > 0
      ? "failure"
      : pending.length > 0
        ? "pending"
        : checks.length === 0
          ? "missing"
          : "success";
  return { state, checks, failing, pending };
}
