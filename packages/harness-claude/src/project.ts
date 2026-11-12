// Writes a run's harness files: the settings (into the run dir, passed with `--settings`, and the
// same bytes into the worktree's `.claude/settings.local.json`), the git config and empty tool dirs
// into the run's private directory, the run's temp dir, and the launch script and record (ADR 0270).
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Job, PlanningRelay } from "@software-factory/runner-contract";
import {
  claudeArgv,
  type LaunchRecord,
  launchPaths,
  launchScript,
  launchUnsets,
  sha256,
} from "./launch.ts";
import { mergeHooks, planningHooks, writePlanningFiles } from "./planning/project.ts";
import {
  type ClaudeSettings,
  defaultTempDirs,
  EMPTY_DIRS,
  EMPTY_FILES,
  runGitConfig,
  runSettings,
  type SettingsOptions,
  TMP_DIRS,
} from "./settings.ts";
import { STATUS_FILE, STATUS_HOOK_SCRIPT, statusHookCommand, statusHookSource } from "./status.ts";

export const DEFAULT_IDENTITY = {
  name: "Software Factory",
  email: "software-factory@users.noreply.github.com",
};

export interface ProjectedHarness {
  settingsPath: string;
  localSettingsPath: string;
  gitConfigPath: string;
  settings: ClaudeSettings;
  launch: LaunchRecord;
  /** Run this with `/bin/sh` in the job's terminal. */
  scriptPath: string;
  runTmp: string;
  /** Where the status hook appends its lines (`<runDir>/status.jsonl`), when it was asked for. */
  statusFile?: string;
}

/** The temp directories a run may write: the system's (symlinks resolved) and `/tmp`. */
export async function systemTempDirs(
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const dirs = new Set([...defaultTempDirs(platform), tmpdir()]);
  dirs.add(await realpath(tmpdir()).catch(() => tmpdir()));
  return [...dirs];
}

export async function projectHarness(
  job: Pick<Job, "stage" | "jobId" | "harness"> & Partial<Pick<Job, "planning" | "workItem">>,
  options: Omit<SettingsOptions, "statusHook"> & {
    identity?: { name: string; email: string };
    claudeBin?: string;
    /**
     * Project the factory's status hook (ADR 0380): its script into the run dir, and the hook on
     * every status event, appending to `<runDir>/status.jsonl`. `node` is the absolute Node that
     * runs it (default: this process's).
     */
    statusHook?: boolean | { node?: string };
    /**
     * A planning job's relay (ADR 0350): the planning MCP server and hooks are projected, and the
     * conversation started or resumed. `nodeBin` runs them (default: this process's Node).
     */
    planning?: { relay: PlanningRelay; nodeBin?: string };
  },
): Promise<ProjectedHarness> {
  const runTmp = options.runTmp ?? join(await realpath(tmpdir()), "software-factory", job.jobId);
  await mkdir(options.runDir, { recursive: true, mode: 0o700 });
  const statusFile = options.statusHook ? join(options.runDir, STATUS_FILE) : undefined;
  const statusScript = join(options.runDir, STATUS_HOOK_SCRIPT);
  const node =
    typeof options.statusHook === "object" && options.statusHook.node
      ? options.statusHook.node
      : process.execPath;
  const planning =
    job.stage === "planning" && options.planning && job.planning && job.workItem
      ? await writePlanningFiles(
          { jobId: job.jobId, workItem: job.workItem, planning: job.planning },
          options.runDir,
          options.planning.relay,
          options.planning.nodeBin ?? process.execPath,
        )
      : null;
  if (job.stage === "planning" && !planning) {
    throw new Error(`planning job ${job.jobId} needs its planning session and relay`);
  }
  const { statusHook: _statusHook, planning: _planning, ...settingsOptions } = options;
  const settings = runSettings(job, {
    ...settingsOptions,
    ...(statusFile ? { statusHook: statusHookCommand(node, statusScript, statusFile) } : {}),
    ...(planning
      ? {
          hooks: mergeHooks(
            options.hooks,
            planningHooks(planning.relayFile, options.planning?.nodeBin ?? process.execPath),
          ),
          denyReadFiles: [...(options.denyReadFiles ?? []), planning.relayFile],
        }
      : {}),
    runTmp,
    tempDirs: options.tempDirs ?? (await systemTempDirs()),
    ...(job.harness.profile && !options.profile ? { profile: job.harness.profile } : {}),
  });
  await mkdir(options.runDir, { recursive: true, mode: 0o700 });
  for (const dir of EMPTY_DIRS)
    await mkdir(join(options.runDir, "empty", dir), { recursive: true });
  for (const file of EMPTY_FILES) await writeFile(join(options.runDir, "empty", file), "");
  for (const dir of TMP_DIRS) await mkdir(join(runTmp, dir), { recursive: true, mode: 0o700 });
  const gitConfigPath = join(options.runDir, "gitconfig");
  await writeFile(gitConfigPath, runGitConfig(options.identity ?? DEFAULT_IDENTITY));

  const paths = launchPaths(options.runDir, options.worktree);
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(paths.runSettings, text, { mode: 0o600 });
  await mkdir(dirname(paths.localSettings), { recursive: true });
  await writeFile(paths.localSettings, text);
  const launch: LaunchRecord = {
    jobId: job.jobId,
    stage: job.stage,
    mode: settings.permissions.defaultMode,
    ...(options.isolation ? { isolation: options.isolation } : {}),
    argv: claudeArgv(job, {
      settingsPath: paths.runSettings,
      ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      ...(planning ? { planning: planning.launch } : {}),
      ...(options.isolation ? { isolation: options.isolation } : {}),
    }),
    settingsHash: sha256(text),
    settingsPaths: [paths.runSettings, paths.localSettings],
    pidFile: paths.pidFile,
    worktree: options.worktree,
  };
  await rm(paths.pidFile, { force: true });
  if (statusFile) {
    await rm(statusFile, { force: true });
    await writeFile(statusScript, statusHookSource(), { mode: 0o600 });
  }
  await writeFile(paths.record, `${JSON.stringify(launch, null, 2)}\n`, { mode: 0o600 });
  await writeFile(paths.script, launchScript(launch, launchUnsets(settings.env)), { mode: 0o700 });
  return {
    settingsPath: paths.runSettings,
    localSettingsPath: paths.localSettings,
    gitConfigPath,
    settings,
    launch,
    scriptPath: paths.script,
    runTmp,
    ...(statusFile ? { statusFile } : {}),
  };
}

/** Removes the run's private directory and its temp dir. Safe to call twice. */
export async function removeRunDir(runDir: string, runTmp?: string): Promise<void> {
  await rm(runDir, { recursive: true, force: true });
  if (runTmp) await rm(runTmp, { recursive: true, force: true });
}

/**
 * The environment for a harness a runner spawns as a child process (a headless `claude -p`): the
 * host's environment with every credential variable dropped, then the settings' overrides on top.
 * A harness launched in a terminal gets the same overrides from the settings file and the launch
 * script's unsets.
 */
export function scrubbedProcessEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const drop =
    /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|^SSH_|^AWS_|^GH_|^GITHUB_|^GIT_|^CLOUDFLARE_|^CF_|^SF_/i;
  for (const [key, value] of Object.entries(base)) {
    // ANTHROPIC_* and CLAUDE_* stay: the model subscription is the runner owner's (ADR 0023).
    if (value === undefined || (drop.test(key) && !/^(ANTHROPIC|CLAUDE)_/.test(key))) continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") delete out[key];
    else out[key] = value;
  }
  return out;
}
