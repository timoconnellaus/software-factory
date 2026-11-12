// @software-factory/harness-claude: the Claude Code harness (ADR 0017). A runner adapter hosts the
// session (a tmux session, a headless process, later a dev box); this package says how Claude
// runs there: the per-run settings it projects (permission mode and allowlist per stage, the OS
// sandbox, deny rules, a credential-free environment), the run's git identity, the exact launch
// command and the post-launch check (ADR 0270), and how to read a session's transcript or stream.
import type { HarnessId, Job } from "@software-factory/runner-contract";
import { claudeArgv } from "./launch.ts";

export * from "./attachments.ts";
export * from "./launch.ts";
export * from "./planning/hooks.ts";
export * from "./planning/mcp.ts";
export * from "./planning/project.ts";
export * from "./planning/relay.ts";
export * from "./project.ts";
export * from "./settings.ts";
export * from "./status.ts";
export * from "./stream-json.ts";
export * from "./transcript.ts";

export const HARNESS_ID: HarnessId = "claude-code";

/** What the harness itself can do, for a runner's manifest. */
export const HARNESS_MANIFEST = {
  id: HARNESS_ID,
  /** Projects the run's settings (permissions, sandbox, env) before launch. */
  projectsSettings: true,
  /** Owns the launch command and verifies the live process against it (ADR 0270). */
  verifiesLaunch: true,
  /** Reads results from the stage result file, never from chat output. */
  resultFile: true,
} as const;

/**
 * Arguments for a headless run (`claude -p`), for runners that spawn Claude themselves: the same
 * factory flags as an interactive launch (`claudeArgv`, without `argv[0]`), then the prompt.
 */
export function headlessArgs(
  job: Pick<Job, "stage" | "harness">,
  options: { settingsPath: string },
): string[] {
  return [
    ...claudeArgv(job, options).slice(1),
    "-p",
    job.harness.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}
