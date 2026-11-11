// The per-run Claude Code settings (ADR 0017, amended; ADR 0033). The harness runs unattended in a
// workspace it doesn't own, so the runner projects a settings file into the worktree before Claude
// starts: a permission profile per stage, deny rules for anything that reaches the owner's
// credentials, and an environment that blanks or redirects every credential source Claude's Bash
// tool could inherit from the runner host (GitHub, SSH, cloud CLIs, the system keychain helper).
//
// It goes to `.claude/settings.local.json`, not `.claude/settings.json`: the local file is Claude
// Code's per-checkout scope, ranks above the project's own committed settings, and is never part of
// the repo, so projecting it can't show up in the run's diff. The runner host excludes it (and the
// result file) from git as well.
import type { Job, JobStage } from "@software-factory/runner-contract";
import { RESULT_FILE } from "@software-factory/runner-contract";

export const SETTINGS_FILE = ".claude/settings.local.json";

/** Files the harness writes into the worktree that must never be committed or pushed. */
export const PRIVATE_WORKTREE_FILES = [SETTINGS_FILE, RESULT_FILE] as const;

/** Claude Code permission modes the factory uses. `dontAsk` denies anything not allowed. */
export type PermissionMode = "dontAsk" | "acceptEdits" | "auto" | "plan";

export interface ClaudeSettings {
  $schema: string;
  permissions: {
    defaultMode: PermissionMode;
    allow: string[];
    deny: string[];
    additionalDirectories?: string[];
  };
  env: Record<string, string>;
  includeCoAuthoredBy: boolean;
  cleanupPeriodDays?: number;
}

export interface SettingsOptions {
  /** The worktree root (absolute). The result file is allowed here only. */
  worktree: string;
  /** Private per-run directory outside the worktree (git config, empty tool config dirs). */
  runDir: string;
  /** Extra absolute paths the harness must not read (the runner's own key file, its run dirs). */
  protectPaths?: string[];
  /** Override the stage's permission mode (the runner owner's choice, e.g. `auto` for builds). */
  permissionMode?: Partial<Record<JobStage, PermissionMode>>;
}

/** Read-only exploration every stage gets. */
const READ_TOOLS = ["Read", "Glob", "Grep", "LS", "TodoWrite", "Task", "WebSearch", "WebFetch"];

const SHELL_READ = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "sort",
  "uniq",
  "diff",
  "pwd",
  "which",
  "echo",
  "printf",
  "test",
  "true",
  "jq",
  "tr",
  "cut",
  "xargs",
  "cd",
  "file",
  "stat",
  "date",
  "basename",
  "dirname",
  "realpath",
  "tree",
];
const GIT_READ = [
  "git status",
  "git log",
  "git show",
  "git diff",
  "git rev-parse",
  "git ls-files",
  "git grep",
  "git blame",
  "git merge-base",
  "git branch --show-current",
];
const SHELL_WRITE = ["mkdir", "cp", "mv", "rm", "touch", "sed", "awk", "chmod", "ln"];
const GIT_WRITE = [
  "git add",
  "git commit",
  "git mv",
  "git rm",
  "git restore",
  "git checkout --",
  "git switch",
];
/** Project tooling: running checks needs these, building needs them more. */
const TOOLCHAIN = ["pnpm", "npm", "npx", "node", "tsc", "biome", "vitest", "turbo", "corepack"];

const bash = (commands: readonly string[]) => commands.map((c) => `Bash(${c}:*)`);

/**
 * Never allowed, whatever the mode: anything that pushes, talks to GitHub or a cloud with the
 * owner's credentials, rewrites git's config or remotes (the host pushes, not the harness), drives
 * the runner itself, or touches the keychain.
 */
export const DENY_COMMANDS = [
  "git push",
  "git remote",
  "git config",
  "git credential",
  "git stash",
  "git worktree",
  "git fetch",
  "git pull",
  "git clone",
  "git submodule",
  "gh",
  "hub",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ssh-add",
  "security",
  "wrangler",
  "npx wrangler",
  "pnpm wrangler",
  "pnpm exec wrangler",
  "aws",
  "gcloud",
  "az",
  "doctl",
  "flyctl",
  "vercel",
  "netlify",
  "orca",
  "claude",
  "sudo",
  "launchctl",
  "osascript",
];

const DENY_READ_HOME = [
  ".ssh/**",
  ".gnupg/**",
  ".aws/**",
  ".azure/**",
  ".config/gh/**",
  ".config/gcloud/**",
  ".config/software-factory/**",
  ".local/state/software-factory/**",
  ".netrc",
  ".git-credentials",
  ".gitconfig",
  ".npmrc",
  ".docker/config.json",
  ".kube/**",
  "Library/Keychains/**",
  "Library/Preferences/.wrangler/**",
  ".wrangler/**",
];

/**
 * The environment Claude (and every Bash command it runs) gets on top of the runner host's: credential
 * variables are blanked, and tools that would fall back to a stored login are pointed at empty
 * directories inside the run dir. Git reads only the run's own global config (identity, no credential
 * helper) and never the system config, which on macOS turns on the keychain helper.
 */
export function harnessEnv(runDir: string): Record<string, string> {
  const empty = (name: string) => `${runDir}/empty/${name}`;
  return {
    // GitHub
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
    GITHUB_PERSONAL_ACCESS_TOKEN: "",
    GH_CONFIG_DIR: empty("gh"),
    // git: no system config (keychain helper), the run's own global config, never prompt, no SSH
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: `${runDir}/gitconfig`,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "false",
    SSH_AUTH_SOCK: "",
    // Cloud CLIs
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_SESSION_TOKEN: "",
    AWS_PROFILE: "",
    AWS_CONFIG_FILE: empty("aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: empty("aws-credentials"),
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_API_KEY: "",
    CF_API_TOKEN: "",
    WRANGLER_HOME: empty("wrangler"),
    XDG_CONFIG_HOME: empty("xdg"),
    GOOGLE_APPLICATION_CREDENTIALS: "",
    CLOUDSDK_CONFIG: empty("gcloud"),
    AZURE_CONFIG_DIR: empty("azure"),
    DIGITALOCEAN_ACCESS_TOKEN: "",
    VERCEL_TOKEN: "",
    NETLIFY_AUTH_TOKEN: "",
    FLY_API_TOKEN: "",
    // Package registries
    NPM_TOKEN: "",
    NODE_AUTH_TOKEN: "",
    // The runner's own secrets, in case the host was started with them in its environment.
    SF_RUNNER_KEY: "",
    SF_JOB_TOKEN: "",
    // Mark the session as a factory run (for the project's own hooks and scripts).
    SOFTWARE_FACTORY_RUN: "1",
  };
}

/** The empty directories `harnessEnv` points at; the caller creates them. */
export const EMPTY_DIRS = ["gh", "wrangler", "xdg", "gcloud", "azure"];

/** The default permission mode per stage. `dontAsk` never stalls on a prompt: it refuses instead. */
export const DEFAULT_MODES: Record<JobStage, PermissionMode> = {
  triage: "dontAsk",
  spec: "dontAsk",
  build: "dontAsk",
  verify: "dontAsk",
};

/** What each stage may do. Triage and spec only read and write the result; verify also runs checks. */
export function stageAllow(stage: JobStage, worktree: string): string[] {
  const result = `//${worktree.replace(/^\/+/, "")}/${RESULT_FILE}`;
  const writeResult = [`Write(${result})`, `Edit(${result})`];
  const read = [...READ_TOOLS, ...bash(SHELL_READ), ...bash(GIT_READ)];
  switch (stage) {
    case "triage":
    case "spec":
      return [...read, ...writeResult];
    case "verify":
      return [...read, ...writeResult, ...bash(TOOLCHAIN)];
    case "build":
      return [
        ...read,
        "Edit",
        "Write",
        "MultiEdit",
        "NotebookEdit",
        ...bash(SHELL_WRITE),
        ...bash(GIT_WRITE),
        ...bash(TOOLCHAIN),
      ];
  }
}

/** The settings for one run. Pure: `projectSettings` writes it. */
export function runSettings(job: Pick<Job, "stage">, options: SettingsOptions): ClaudeSettings {
  const mode = options.permissionMode?.[job.stage] ?? DEFAULT_MODES[job.stage];
  const readDeny = [
    ...DENY_READ_HOME.map((p) => `~/${p}`),
    ...(options.protectPaths ?? []).map((p) => `//${p.replace(/^\/+/, "")}/**`),
  ];
  return {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: {
      defaultMode: mode,
      allow: stageAllow(job.stage, options.worktree),
      deny: [
        ...bash(DENY_COMMANDS),
        ...readDeny.map((p) => `Read(${p})`),
        ...readDeny.map((p) => `Edit(${p})`),
        // The worktree's git internals are the host's (it pushes from them).
        "Edit(.git/**)",
        "Write(.git/**)",
      ],
    },
    env: harnessEnv(options.runDir),
    includeCoAuthoredBy: false,
  };
}

/** The run's private git config: an identity for commits, and no credential helper at all. */
export function runGitConfig(identity: { name: string; email: string }): string {
  return [
    "# Written by the software factory runner for one run. No credential helper: the harness",
    "# can commit but never push; the runner host pushes with the job token.",
    "[user]",
    `\tname = ${identity.name}`,
    `\temail = ${identity.email}`,
    "[credential]",
    "\thelper =",
    "[commit]",
    "\tgpgsign = false",
    "[tag]",
    "\tgpgsign = false",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
}
