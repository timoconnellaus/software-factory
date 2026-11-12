// How Claude Code is started for a run, and the check that it really started that way (ADR 0270,
// incident 2026-11-11 bootstrap #6). The harness owns the exact invocation: a runner adapter only
// hosts it (a tmux session, a headless process) and runs the launch script as it is.
//
//   claude --permission-mode <mode> --setting-sources project,local
//          --settings <runDir>/claude-settings.json --strict-mcp-config [--model <model>]
//
// No user settings source, so the owner's personal Claude config (their own default mode, hooks,
// plugins) never applies to a run. No MCP servers, except a planning session's own planning server
// (`--mcp-config`), which starts (`--session-id`) or resumes (`--resume`) a known conversation. The prompt is not an argument: the adapter sends
// it once the launch is verified, so nothing runs before the check passes.
//
// After launch, `inspectLaunch` reads the pid the launch script recorded, the live process's
// command line (`ps`), and both copies of the settings file, and `launchProblems` compares them with
// the launch record. Any difference is `harness-config-mismatch`: the adapter kills the session and
// the job fails, which opens a factory incident.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessProfile, Job, JobStage } from "@software-factory/runner-contract";
import type { PlanningLaunch } from "./planning/project.ts";
import { type PermissionMode, RUN_SETTINGS_FILE, SETTINGS_FILE, stageMode } from "./settings.ts";

/** The setting sources a run loads: the repo's and the projected local file, never the user's. */
export const SETTING_SOURCES = "project,local";
/** The reason a job fails with when the live harness isn't configured as the factory set it. */
export const HARNESS_CONFIG_MISMATCH = "harness-config-mismatch";
export const LAUNCH_SCRIPT = "launch.sh";
export const LAUNCH_RECORD = "launch.json";
export const PID_FILE = "claude.pid";

/** What a run's Claude must look like once it is running. Written to `<runDir>/launch.json`. */
export interface LaunchRecord {
  jobId: string;
  stage: JobStage;
  mode: PermissionMode;
  /** The exact argv, `argv[0]` included. */
  argv: string[];
  /** sha256 of the projected settings (both copies have the same bytes). */
  settingsHash: string;
  settingsPaths: string[];
  pidFile: string;
  worktree: string;
  /**
   * The Claude account the run uses (ADR 0410), and its config dir (absent for `default`). Names and
   * paths only, never a token. Older records have neither.
   */
  account?: string;
  configDir?: string;
}

/** The exact argv for a run's Claude. */
export function claudeArgv(
  job: Pick<Job, "stage" | "harness">,
  options: {
    settingsPath: string;
    claudeBin?: string;
    profile?: HarnessProfile;
    /** A planning session (ADR 0350): its MCP server, and the conversation to start or resume. */
    planning?: PlanningLaunch;
  },
): string[] {
  const planning = options.planning;
  return [
    options.claudeBin ?? "claude",
    "--permission-mode",
    stageMode(job.stage, options.profile ?? job.harness.profile),
    "--setting-sources",
    SETTING_SOURCES,
    "--settings",
    options.settingsPath,
    "--strict-mcp-config",
    ...(planning
      ? [
          "--mcp-config",
          planning.mcpConfigPath,
          planning.resume ? "--resume" : "--session-id",
          planning.sessionRef,
        ]
      : []),
    ...(job.harness.model ? ["--model", job.harness.model] : []),
  ];
}

/** Quotes one word for `/bin/sh`. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Environment variables the launch script unsets before starting Claude: every credential the
 * harness env blanks, and `CLAUDE_CODE_PLUGIN_DIRS`, which a terminal host may set to bring
 * plugins in (harmless when unset).
 */
export function launchUnsets(env: Record<string, string>): string[] {
  return [
    ...Object.entries(env)
      .filter(([, v]) => v === "")
      .map(([k]) => k),
    "CLAUDE_CODE_PLUGIN_DIRS",
  ];
}

/**
 * The launch script a runner runs (with `/bin/sh`) in the job's terminal: it records its pid,
 * which `exec` hands to Claude, so the check can find the process without guessing. `account` is
 * the lines that give Claude its account (`accountLaunchLines`, ADR 0410).
 */
export function launchScript(
  record: LaunchRecord,
  unset: readonly string[],
  account: readonly string[] = [],
): string {
  return [
    "#!/bin/sh",
    `# Written by the software factory runner for job ${record.jobId} (${record.stage}).`,
    "# The harness's own invocation (ADR 0270); the runner checks the live process against",
    `# ${LAUNCH_RECORD} before it sends the prompt.`,
    ...(unset.length ? [`unset ${unset.map(shellQuote).join(" ")}`] : []),
    ...account,
    `cd ${shellQuote(record.worktree)} || exit 97`,
    `echo $$ > ${shellQuote(record.pidFile)} || exit 98`,
    `exec ${record.argv.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Where a run's harness files are, from its run dir and worktree. */
export function launchPaths(runDir: string, worktree: string) {
  return {
    runSettings: join(runDir, RUN_SETTINGS_FILE),
    localSettings: join(worktree, SETTINGS_FILE),
    script: join(runDir, LAUNCH_SCRIPT),
    record: join(runDir, LAUNCH_RECORD),
    pidFile: join(runDir, PID_FILE),
  };
}

/** What was observed of a running harness. */
export interface ObservedLaunch {
  pid: number | null;
  /** `ps -o command=` for the pid: argv joined with spaces. Null when the process is gone. */
  command: string | null;
  /** sha256 per settings path; null when the file is missing. */
  settingsHashes: Record<string, string | null>;
}

/** What differs from the launch record. Empty when the harness runs exactly as the factory set it. */
export function launchProblems(record: LaunchRecord, observed: ObservedLaunch): string[] {
  const problems: string[] = [];
  if (observed.pid === null) problems.push("the launch script recorded no pid");
  else if (observed.command === null) problems.push(`no process ${observed.pid}`);
  else {
    const expected = record.argv.join(" ");
    if (observed.command !== expected) {
      const mode = /--permission-mode[ =](\S+)/.exec(observed.command)?.[1];
      problems.push(
        `the process runs \`${observed.command.slice(0, 500)}\`, not \`${expected}\`` +
          (mode && mode !== record.mode
            ? ` (permission mode ${mode}, expected ${record.mode})`
            : ""),
      );
    }
  }
  for (const path of record.settingsPaths) {
    const hash = observed.settingsHashes[path];
    if (hash === null || hash === undefined) problems.push(`${path} is missing`);
    else if (hash !== record.settingsHash) problems.push(`${path} changed since it was projected`);
  }
  return problems;
}

export type ReadCommand = (pid: number) => Promise<string | null>;

/** `ps -ww -o command= -p <pid>`: the process's argv, or null when it is gone. */
export const psCommand: ReadCommand = (pid) =>
  new Promise((resolve) => {
    execFile("ps", ["-ww", "-o", "command=", "-p", String(pid)], (error, stdout) => {
      const line = String(stdout).replace(/\n$/, "");
      resolve(error || !line ? null : line);
    });
  });

export async function readLaunchRecord(runDir: string): Promise<LaunchRecord | null> {
  try {
    return JSON.parse(await readFile(join(runDir, LAUNCH_RECORD), "utf8")) as LaunchRecord;
  } catch {
    return null;
  }
}

/** Observes the running harness for a launch record. */
export async function inspectLaunch(
  record: LaunchRecord,
  readCommand: ReadCommand = psCommand,
): Promise<ObservedLaunch> {
  const raw = await readFile(record.pidFile, "utf8").catch(() => "");
  const pid = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  const settingsHashes: Record<string, string | null> = {};
  for (const path of record.settingsPaths) {
    settingsHashes[path] = await readFile(path).then(sha256, () => null);
  }
  return { pid, command: pid === null ? null : await readCommand(pid), settingsHashes };
}

/** Inspects and compares in one go: the problems, empty when the harness is as the factory set it. */
export async function verifyLaunch(
  record: LaunchRecord,
  readCommand: ReadCommand = psCommand,
): Promise<string[]> {
  return launchProblems(record, await inspectLaunch(record, readCommand));
}
