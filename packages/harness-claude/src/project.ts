// Writes a run's harness files: the settings into the worktree, the git config and empty tool dirs
// into the run's private directory (outside the worktree, removed when the job is released).
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Job } from "@software-factory/runner-contract";
import {
  type ClaudeSettings,
  EMPTY_DIRS,
  runGitConfig,
  runSettings,
  SETTINGS_FILE,
  type SettingsOptions,
} from "./settings.ts";

export const DEFAULT_IDENTITY = {
  name: "Software Factory",
  email: "software-factory@users.noreply.github.com",
};

export interface ProjectedHarness {
  settingsPath: string;
  gitConfigPath: string;
  settings: ClaudeSettings;
}

export async function projectHarness(
  job: Pick<Job, "stage">,
  options: SettingsOptions & { identity?: { name: string; email: string } },
): Promise<ProjectedHarness> {
  const settings = runSettings(job, options);
  await mkdir(options.runDir, { recursive: true, mode: 0o700 });
  for (const dir of EMPTY_DIRS)
    await mkdir(join(options.runDir, "empty", dir), { recursive: true });
  const gitConfigPath = join(options.runDir, "gitconfig");
  await writeFile(gitConfigPath, runGitConfig(options.identity ?? DEFAULT_IDENTITY));
  const settingsPath = join(options.worktree, SETTINGS_FILE);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { settingsPath, gitConfigPath, settings };
}

/** Removes the run's private directory. Safe to call twice. */
export async function removeRunDir(runDir: string): Promise<void> {
  await rm(runDir, { recursive: true, force: true });
}

/**
 * The environment for a harness the runner spawns itself (runner-local): the host's environment
 * with every credential variable dropped, then the settings' overrides on top. Orca launches
 * Claude in its own terminal, so for runner-orca the settings file carries the same overrides.
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
