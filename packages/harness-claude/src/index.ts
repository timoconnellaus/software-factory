// @software-factory/harness-claude: the Claude Code harness (ADR 0017). A runner adapter hosts the
// session (an Orca terminal, a headless process, later a dev box); this package says how Claude
// runs there: the per-run settings it projects (permission profile per stage, deny rules, a
// credential-free environment), the run's git identity, the headless launch arguments, and how to
// read a session's transcript or stream back.
import type { HarnessId, Job } from "@software-factory/runner-contract";

export * from "./project.ts";
export * from "./settings.ts";
export * from "./transcript.ts";

export const HARNESS_ID: HarnessId = "claude-code";

/** What the harness itself can do, for a runner's manifest. */
export const HARNESS_MANIFEST = {
  id: HARNESS_ID,
  /** Projects `.claude/settings.local.json` (permissions, env) into the workspace before launch. */
  projectsSettings: true,
  /** Reads results from the stage result file, never from chat output. */
  resultFile: true,
} as const;

/** Arguments for a headless run (`claude -p`), for runners that spawn Claude themselves. */
export function headlessArgs(job: Pick<Job, "harness">): string[] {
  return [
    "-p",
    job.harness.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    ...(job.harness.model ? ["--model", job.harness.model] : []),
  ];
}
