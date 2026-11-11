// The per-run Claude Code settings (ADR 0017, amended; ADR 0033, 0250, 0261). The harness runs
// unattended in a workspace it doesn't own, so the runner projects a settings file before Claude
// starts: a permission mode and allowlist per stage, deny rules for anything that reaches the
// owner's credentials, Claude Code's OS sandbox for every Bash command (filesystem writes limited to
// the worktree and temp, network limited to an allowlist), and an environment that blanks or
// redirects every credential source a command could inherit from the runner host.
//
// The file is written twice with the same bytes: `<runDir>/claude-settings.json`, which the launch
// passes with `--settings` (flag scope: it ranks above the repo's own settings, and the sandbox
// treats its `allowUnsandboxedCommands: false` and `strictAllowlist` as closed to project settings),
// and `.claude/settings.local.json` in the worktree, Claude Code's per-checkout scope, never part of
// the repo. Claude is launched with `--setting-sources project,local`, so the owner's user settings
// (their own permission mode, hooks and plugins) never apply to a run.
import type {
  HarnessPermissionMode,
  HarnessProfile,
  Job,
  JobStage,
} from "@software-factory/runner-contract";
import { RESULT_FILE } from "@software-factory/runner-contract";

export const SETTINGS_FILE = ".claude/settings.local.json";
/** The authoritative copy, in the run's private directory, passed with `--settings`. */
export const RUN_SETTINGS_FILE = "claude-settings.json";

/** Files the harness writes into the worktree that must never be committed or pushed. */
export const PRIVATE_WORKTREE_FILES = [SETTINGS_FILE, RESULT_FILE] as const;

/** Claude Code permission modes the factory uses (ADR 0261). */
export type PermissionMode = HarnessPermissionMode;

/** Claude Code hooks, as the settings file spells them. */
export type ClaudeHooks = Record<
  string,
  Array<{
    matcher?: string;
    hooks: Array<{ type: "command"; command: string; timeout?: number }>;
  }>
>;

export interface ClaudeSettings {
  $schema: string;
  permissions: {
    defaultMode: PermissionMode;
    allow: string[];
    deny: string[];
    /** File tools write only inside the working directories, whatever the mode. */
    blockWritesOutsideWorkingDirectories: true;
  };
  sandbox: {
    enabled: true;
    /** Refuse to start rather than run commands unsandboxed. */
    failIfUnavailable: true;
    /** Never: `dangerouslyDisableSandbox` is ignored. The floor; no profile can change it. */
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: boolean;
    excludedCommands: string[];
    network: {
      allowedDomains: string[];
      /** Deny hosts off the list instead of prompting (an unattended run has nobody to ask). */
      strictAllowlist: true;
      /** Local ports only: dev servers and the workerd test pool bind localhost. */
      allowLocalBinding: boolean;
    };
    filesystem: {
      allowWrite: string[];
      denyWrite: string[];
      denyRead: string[];
      allowRead: string[];
    };
  };
  env: Record<string, string>;
  hooks?: ClaudeHooks;
  includeCoAuthoredBy: boolean;
  /** Bypass mode's confirmation dialog would stall an unattended run. Set only with bypass. */
  skipDangerousModePermissionPrompt?: true;
}

export interface SettingsOptions {
  /** The worktree root (absolute). */
  worktree: string;
  /** Private per-run directory outside the worktree (settings, git config, launch record). */
  runDir: string;
  /** Per-run scratch directory (caches, tool homes). Writable by the harness. */
  runTmp?: string;
  /** Extra absolute paths the harness must not read (the runner's own key file, its run dirs). */
  protectPaths?: string[];
  /**
   * Git directories outside the worktree that the run's own git needs: a linked worktree keeps its
   * objects and refs in the main checkout's git dir. Readable and writable (objects, refs, logs and
   * this worktree's admin dir only), even when the checkout itself is protected.
   */
  git?: { commonDir: string; gitDir: string };
  /** Temp directories sandboxed commands may write (absolute, symlinks resolved). */
  tempDirs?: string[];
  /** The project's harness settings from its default-branch policy (ADR 0261). */
  profile?: HarnessProfile;
  /**
   * Hooks the runner adapter needs (status reporting to its UI). Never a hook that can answer a
   * permission decision: those events are refused.
   */
  hooks?: ClaudeHooks;
}

/** Hook events whose output can grant a permission or answer a dialog: a runner may not add them. */
export const DECISION_HOOK_EVENTS = ["PreToolUse", "PermissionRequest", "Elicitation"] as const;

/** Read-only exploration every stage gets. `WebFetch` is added per allowed domain. */
const READ_TOOLS = ["Read", "Glob", "Grep", "LS", "TodoWrite", "Task", "WebSearch"];

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

/** Home paths no stage may read or write: credentials, the runner's own files, the keychains. */
export const DENY_HOME = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gh",
  ".config/gcloud",
  ".config/software-factory",
  ".local/state/software-factory",
  ".netrc",
  ".git-credentials",
  ".gitconfig",
  ".npmrc",
  ".docker/config.json",
  ".kube",
  "Library/Keychains",
  "Library/Preferences/.wrangler",
  ".wrangler",
];

/**
 * Hosts sandboxed commands may reach in every stage: the npm registry (npm, pnpm, corepack),
 * GitHub (dependencies from git; the harness has no token for it), and the Cloudflare API.
 */
export const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "github.com",
  "api.github.com",
  "api.cloudflare.com",
];

/**
 * The environment Claude (and every Bash command it runs) gets on top of the runner host's: credential
 * variables are blanked, and tools that would fall back to a stored login are pointed at empty
 * directories inside the run dir. Git reads only the run's own global config (identity, no credential
 * helper) and never the system config, which on macOS turns on the keychain helper. Tool caches and
 * homes that must be writable go to the run's temp dir (the sandbox allows writes only there and in
 * the worktree).
 */
export function harnessEnv(runDir: string, runTmp = `${runDir}/tmp`): Record<string, string> {
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
    WRANGLER_HOME: `${runTmp}/wrangler`,
    XDG_CONFIG_HOME: `${runTmp}/xdg-config`,
    XDG_CACHE_HOME: `${runTmp}/xdg-cache`,
    GOOGLE_APPLICATION_CREDENTIALS: "",
    CLOUDSDK_CONFIG: empty("gcloud"),
    AZURE_CONFIG_DIR: empty("azure"),
    DIGITALOCEAN_ACCESS_TOKEN: "",
    VERCEL_TOKEN: "",
    NETLIFY_AUTH_TOKEN: "",
    FLY_API_TOKEN: "",
    // Package registries: no token, an empty user config, caches in the run's temp dir.
    NPM_TOKEN: "",
    NODE_AUTH_TOKEN: "",
    NPM_CONFIG_USERCONFIG: empty("npmrc"),
    npm_config_cache: `${runTmp}/npm-cache`,
    // pnpm's store is content-addressed and checked on read, so runs share one in temp.
    npm_config_store_dir: `${runTmp.replace(/\/[^/]+\/?$/, "")}/pnpm-store`,
    COREPACK_HOME: `${runTmp}/corepack`,
    // The runner's own secrets, in case the host was started with them in its environment.
    SF_RUNNER_KEY: "",
    SF_JOB_TOKEN: "",
    // Mark the session as a factory run (for the project's own hooks and scripts).
    SOFTWARE_FACTORY_RUN: "1",
  };
}

/** The empty directories `harnessEnv` points at, under `<runDir>/empty/`; the caller creates them. */
export const EMPTY_DIRS = ["gh", "gcloud", "azure"];
/** The empty files `harnessEnv` points at, under `<runDir>/empty/`. */
export const EMPTY_FILES = ["npmrc", "aws-config", "aws-credentials"];
/** Directories under the run's temp dir that `harnessEnv` points at. */
export const TMP_DIRS = ["wrangler", "xdg-config", "xdg-cache", "npm-cache", "corepack"];

/**
 * The default permission mode per stage. Build runs in `bypassPermissions` inside the sandbox (its
 * edits and commands are confined by the OS, not by an allowlist it would outgrow); the rest stay
 * on `dontAsk` with a stage allowlist, which refuses anything else instead of stalling on a prompt.
 */
export const DEFAULT_MODES: Record<JobStage, PermissionMode> = {
  triage: "dontAsk",
  spec: "dontAsk",
  build: "bypassPermissions",
  verify: "dontAsk",
};

/** The permission mode a stage runs in: the project's choice, else the default. */
export function stageMode(stage: JobStage, profile?: HarnessProfile): PermissionMode {
  return profile?.permissionMode?.[stage] ?? DEFAULT_MODES[stage];
}

/** The hosts sandboxed commands may reach: the defaults plus the project's additions. */
export function allowedDomains(profile?: HarnessProfile): string[] {
  return [...new Set([...DEFAULT_ALLOWED_DOMAINS, ...(profile?.allowedDomains ?? [])])];
}

/** What each stage may do. Triage and spec only read and write the result; verify also runs checks. */
export function stageAllow(
  stage: JobStage,
  worktree: string,
  domains: readonly string[] = DEFAULT_ALLOWED_DOMAINS,
): string[] {
  const result = `${abs(worktree)}/${RESULT_FILE}`;
  const writeResult = [`Write(${result})`, `Edit(${result})`];
  const read = [
    ...READ_TOOLS,
    ...domains.map((d) => `WebFetch(domain:${d})`),
    ...bash(SHELL_READ),
    ...bash(GIT_READ),
  ];
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

/** `//abs/path`: an absolute path in a permission rule (a single `/` is relative to the settings). */
const abs = (path: string) => `//${path.replace(/^\/+/, "")}`;

/** The settings for one run. Pure: `projectHarness` writes it. */
export function runSettings(job: Pick<Job, "stage">, options: SettingsOptions): ClaudeSettings {
  const profile = options.profile;
  const mode = stageMode(job.stage, profile);
  const domains = allowedDomains(profile);
  const runTmp = options.runTmp ?? `${options.runDir}/tmp`;
  for (const event of DECISION_HOOK_EVENTS) {
    if (options.hooks?.[event]) {
      throw new Error(`a runner may not add ${event} hooks: they can answer permission decisions`);
    }
  }
  const homeDeny = DENY_HOME.map((p) => `~/${p}`);
  const protect = options.protectPaths ?? [];
  // The worktree's Claude config is the factory's: the run may not change its own settings, hooks
  // or the project's (a hook runs outside the sandbox, so a run that wrote one could escape it).
  const configDir = `${options.worktree}/.claude`;
  const homeRules = homeDeny.flatMap((p) => [p, `${p}/**`]);
  const readDeny = [...homeRules, ...protect.map((p) => `${abs(p)}/**`)];
  // Writes outside the worktree are blocked for the file tools (blockWritesOutsideWorkingDirectories)
  // and for commands (the sandbox's allowWrite). No Edit deny on the protected paths: Claude merges
  // Edit denies into the sandbox's denyWrite, which would also block the run's git from writing
  // objects into the checkout's git dir.
  const writeDeny = [...homeRules, `${abs(configDir)}`, `${abs(configDir)}/**`];
  const allow = [...stageAllow(job.stage, options.worktree, domains)];
  for (const rule of profile?.allow?.[job.stage] ?? []) if (!allow.includes(rule)) allow.push(rule);
  const deny = [
    ...bash(DENY_COMMANDS),
    ...readDeny.map((p) => `Read(${p})`),
    ...writeDeny.map((p) => `Edit(${p})`),
    ...writeDeny.map((p) => `Write(${p})`),
    // The worktree's git internals are the host's (it pushes from them).
    "Edit(.git/**)",
    "Write(.git/**)",
    // Bypass mode allows every tool: WebFetch isn't sandboxed, so it can't be held to the host
    // allowlist there. Builds fetch through sandboxed commands (to the allowlist) instead.
    ...(mode === "bypassPermissions" ? ["WebFetch"] : []),
  ];
  const git = options.git;
  const gitWrite = git
    ? [
        `${git.commonDir}/objects`,
        `${git.commonDir}/refs`,
        `${git.commonDir}/logs`,
        `${git.commonDir}/packed-refs`,
        git.gitDir,
      ]
    : [];
  const settings: ClaudeSettings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: {
      defaultMode: mode,
      allow,
      deny,
      blockWritesOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Only where the mode lets everything through anyway; elsewhere the stage allowlist decides.
      autoAllowBashIfSandboxed: mode === "bypassPermissions",
      excludedCommands: [],
      network: { allowedDomains: domains, strictAllowlist: true, allowLocalBinding: true },
      filesystem: {
        allowWrite: [
          options.worktree,
          runTmp,
          ...(options.tempDirs ?? ["/tmp", "/private/tmp"]),
          ...gitWrite,
        ],
        denyWrite: [
          ...homeDeny,
          configDir,
          ...(git ? [`${git.commonDir}/config`, `${git.commonDir}/hooks`] : []),
        ],
        denyRead: [...homeDeny, ...protect],
        // The run's own private files (git config, empty tool dirs) and the checkout's git dir sit
        // under protected paths; the run's git must still read them.
        allowRead: [options.runDir, ...(git ? [git.commonDir] : [])],
      },
    },
    env: harnessEnv(options.runDir, runTmp),
    includeCoAuthoredBy: false,
  };
  if (options.hooks && Object.keys(options.hooks).length > 0) settings.hooks = options.hooks;
  if (mode === "bypassPermissions") settings.skipDangerousModePermissionPrompt = true;
  return settings;
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
