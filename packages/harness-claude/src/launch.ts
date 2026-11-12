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
// command line (`/proc/<pid>/cmdline` on Linux, `ps` elsewhere), and both copies of the settings file, and `launchProblems` compares them with
// the launch record. Any difference is `harness-config-mismatch`: the adapter kills the session and
// the job fails, which opens a factory incident.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessProfile, Job, JobStage } from "@software-factory/runner-contract";
import type { PlanningLaunch } from "./planning/project.ts";
import {
  type Isolation,
  type PermissionMode,
  RUN_SETTINGS_FILE,
  SETTINGS_FILE,
  stageMode,
} from "./settings.ts";

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
  /** Where the run is confined (ADR 0430); absent in records from before it (the sandbox). */
  isolation?: Isolation;
  /** The exact argv, `argv[0]` included. */
  argv: string[];
  /** sha256 of the projected settings (both copies have the same bytes). */
  settingsHash: string;
  settingsPaths: string[];
  pidFile: string;
  worktree: string;
  /**
   * A stream-json session (ADR 0450): its conversation id, for `claude --resume`. Absent for a
   * terminal (TUI) session.
   */
  stream?: {
    sessionId: string;
    /** `<runDir>/resume.sh`: the takeover's script, the launch's environment and account. */
    resumeScript?: string;
  };
  /** The variables the launch script unsets (for the takeover command, ADR 0450). */
  unset?: string[];
  /**
   * The Claude account the run uses (ADR 0410), and its config dir (absent for `default`). Names and
   * paths only, never a token. Older records have neither.
   */
  account?: string;
  configDir?: string;
}

/**
 * The flags that make a run a two-way stream-json session (ADR 0450): print mode, JSON lines in
 * and out, and no permission prompts (anything that would prompt is denied; the mode and allow
 * rules decide the rest, so nothing waits on an answer no one gives).
 */
export const STREAM_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-prompts",
  "none",
] as const;

/** The exact argv for a run's Claude. */
export function claudeArgv(
  job: Pick<Job, "stage" | "harness">,
  options: {
    settingsPath: string;
    claudeBin?: string;
    profile?: HarnessProfile;
    /** A planning session (ADR 0350): its MCP server, and the conversation to start or resume. */
    planning?: PlanningLaunch;
    /**
     * A stream-json session (ADR 0450). A non-planning one starts its own conversation with
     * `sessionId`; a planning one keeps the planning session's.
     */
    stream?: { sessionId?: string };
    /** A container per job changes the stage's default mode (ADR 0430). */
    isolation?: Isolation;
  },
): string[] {
  const planning = options.planning;
  const stream = options.stream;
  return [
    options.claudeBin ?? "claude",
    "--permission-mode",
    stageMode(job.stage, options.profile ?? job.harness.profile, options.isolation),
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
    ...(stream && !planning && stream.sessionId ? ["--session-id", stream.sessionId] : []),
    ...(job.harness.model ? ["--model", job.harness.model] : []),
    ...(stream ? STREAM_FLAGS : []),
  ];
}

/**
 * The interactive command that resumes a stream session's conversation in a terminal (ADR 0450):
 * the launch's argv without the stream flags and without its own `--session-id`/`--resume`, then
 * `--resume <sessionId>`. The same settings, setting sources, permission mode, MCP config and model
 * as the run.
 */
export function resumeArgv(record: Pick<LaunchRecord, "argv">, sessionId: string): string[] {
  const out: string[] = [];
  const argv = record.argv;
  const withValue = new Set([
    "--session-id",
    "--resume",
    "--input-format",
    "--output-format",
    "--permission-prompts",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (withValue.has(a)) {
      i++;
      continue;
    }
    if (a === "-p" || a === "--verbose") continue;
    out.push(a);
  }
  return [...out, "--resume", sessionId];
}

/**
 * `resumeArgv` as one shell line, run in the worktree with the launch script's variables unset:
 * `cd <worktree> && env -u … claude … --resume <id>`.
 */
export function resumeCommand(
  record: Pick<LaunchRecord, "argv" | "worktree" | "unset" | "stream" | "account" | "configDir">,
  sessionId: string,
): string {
  const unset = (record.unset ?? []).flatMap((k) => ["-u", k]);
  const words = [...(unset.length ? ["env", ...unset] : []), ...resumeArgv(record, sessionId)];
  const line = `cd ${shellQuote(record.worktree)} && ${words.map(shellQuote).join(" ")}`;
  // With its resume script (the launch's environment and Claude account, ADR 0410), run that;
  // the second line says what it runs.
  const script = record.stream?.resumeScript;
  if (!script) return line;
  const account =
    record.account && record.configDir ? `, on Claude account "${record.account}"` : "";
  return `sh ${shellQuote(script)}\n# runs${account}: ${line}`;
}

export const RESUME_SCRIPT = "resume.sh";

/**
 * The takeover's script (ADR 0450): the launch script's environment, unsets and account, then the
 * interactive `claude --resume <id>` in the worktree. No pid file: the runner never checks it.
 */
export function resumeScript(
  record: Pick<LaunchRecord, "argv" | "worktree" | "jobId" | "stream">,
  unset: readonly string[],
  account: readonly string[] = [],
): string {
  const sessionId = record.stream?.sessionId ?? "";
  return [
    "#!/bin/sh",
    `# Written by the software factory runner for job ${record.jobId}: resumes its stream session`,
    "# in this terminal after a takeover (ADR 0450). Quitting it hands the run back.",
    ...(unset.length ? [`unset ${unset.map(shellQuote).join(" ")}`] : []),
    ...account,
    `cd ${shellQuote(record.worktree)} || exit 97`,
    `exec ${resumeArgv(record, sessionId).map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
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

/**
 * The live process's argv joined with spaces (what `ps -o command=` prints), or null when it is
 * gone. On Linux it reads `/proc/<pid>/cmdline`, so a host without procps (a slim image) can still
 * run the ADR 0270 check (ADR 0420); elsewhere it runs `ps -ww -o command= -p <pid>`.
 */
export const psCommand: ReadCommand = (pid) =>
  process.platform === "linux" ? procCommand(pid) : bsdPsCommand(pid);

/** `/proc/<pid>/cmdline`: NUL-separated argv. Empty for a zombie or kernel thread (null). */
export const procCommand: ReadCommand = async (pid) => {
  const raw = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  const argv = raw.replace(/\0$/, "").split("\0");
  return raw === "" ? null : argv.join(" ");
};

const bsdPsCommand: ReadCommand = (pid) =>
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
