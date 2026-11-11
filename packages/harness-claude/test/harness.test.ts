import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Job, RESULT_FILE } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkOutputLog,
  claudeArgv,
  findTranscript,
  harnessEnv,
  headlessArgs,
  type LaunchRecord,
  launchProblems,
  launchScript,
  parseTranscript,
  projectDirName,
  projectHarness,
  psCommand,
  readLaunchRecord,
  runSettings,
  SETTINGS_FILE,
  scrubbedProcessEnv,
  streamJsonToEvents,
  verifyLaunch,
} from "../src/index.ts";

const dirs: string[] = [];
const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const job = (stage: Job["stage"], harness: Partial<Job["harness"]> = {}) => ({
  jobId: "job_1",
  stage,
  harness: { id: "claude-code" as const, role: "implement" as const, prompt: "p", ...harness },
});

describe("run settings", () => {
  it("lets triage only read and write its result file, in dontAsk", () => {
    const s = runSettings({ stage: "triage" }, { worktree: "/w/job", runDir: "/r/job" });
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(s.permissions.allow).toContain(`Write(//w/job/${RESULT_FILE})`);
    expect(s.permissions.allow).not.toContain("Write");
    expect(s.permissions.allow).not.toContain("Edit");
    expect(s.permissions.allow.some((r) => r.startsWith("Bash(pnpm"))).toBe(false);
    // WebFetch only to the allowlist; Bash isn't auto-allowed by the sandbox outside bypass.
    expect(s.permissions.allow).not.toContain("WebFetch");
    expect(s.permissions.allow).toContain("WebFetch(domain:registry.npmjs.org)");
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(false);
  });

  it("lets verify run the toolchain but not edit", () => {
    const s = runSettings({ stage: "verify" }, { worktree: "/w/job", runDir: "/r/job" });
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(s.permissions.allow).toContain("Bash(pnpm:*)");
    expect(s.permissions.allow).not.toContain("Edit");
  });

  it("runs build in bypassPermissions inside the sandbox, never pushing", () => {
    const s = runSettings({ stage: "build" }, { worktree: "/w/job", runDir: "/r/job" });
    expect(s.permissions.defaultMode).toBe("bypassPermissions");
    expect(s.skipDangerousModePermissionPrompt).toBe(true);
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        "Bash(git push:*)",
        "Bash(gh:*)",
        "Bash(git config:*)",
        "Bash(wrangler:*)",
        "Read(~/.ssh/**)",
        "Read(~/.config/gh/**)",
        "Read(~/.wrangler/**)",
        "Read(~/Library/Keychains/**)",
        "Edit(~/.ssh/**)",
        // WebFetch isn't sandboxed and bypass would let it reach anywhere.
        "WebFetch",
      ]),
    );
    expect(s.permissions.allow.some((r) => r.includes("git push"))).toBe(false);
  });

  it("turns the sandbox on in every stage, with no way to run unsandboxed", () => {
    for (const stage of ["triage", "spec", "build", "verify"] as const) {
      const s = runSettings(
        { stage },
        {
          worktree: "/w/job",
          runDir: "/r/job",
          runTmp: "/t/job",
          tempDirs: ["/tmp"],
          protectPaths: ["/home/me/.config/software-factory", "/home/me/checkout"],
          git: {
            commonDir: "/home/me/checkout/.git",
            gitDir: "/home/me/checkout/.git/worktrees/job",
          },
        },
      );
      expect(s.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
      });
      expect(s.sandbox.network.strictAllowlist).toBe(true);
      expect(s.sandbox.network.allowedDomains).toEqual([
        "registry.npmjs.org",
        "github.com",
        "api.github.com",
        "api.cloudflare.com",
      ]);
      // Writes: the worktree, temp, and the run's own git objects and refs; never git config/hooks.
      expect(s.sandbox.filesystem.allowWrite).toEqual([
        "/w/job",
        "/t/job",
        "/tmp",
        "/home/me/checkout/.git/objects",
        "/home/me/checkout/.git/refs",
        "/home/me/checkout/.git/logs",
        "/home/me/checkout/.git/packed-refs",
        "/home/me/checkout/.git/worktrees/job",
      ]);
      expect(s.sandbox.filesystem.denyWrite).toEqual(
        expect.arrayContaining([
          "~/.ssh",
          "~/.config/gh",
          "~/.wrangler",
          "~/Library/Keychains",
          "/w/job/.claude",
          "/home/me/checkout/.git/config",
          "/home/me/checkout/.git/hooks",
        ]),
      );
      expect(s.sandbox.filesystem.denyRead).toEqual(
        expect.arrayContaining([
          "~/.ssh",
          "/home/me/.config/software-factory",
          "/home/me/checkout",
        ]),
      );
      expect(s.sandbox.filesystem.allowRead).toEqual(["/r/job", "/home/me/checkout/.git"]);
      expect(s.permissions.blockWritesOutsideWorkingDirectories).toBe(true);
      expect(JSON.stringify(s)).not.toMatch(/"allowUnsandboxedCommands":\s*true/);
    }
  });

  it("takes the project's modes and allowlists, but never loosens the floor", () => {
    const profile = {
      permissionMode: { verify: "bypassPermissions" as const, build: "dontAsk" as const },
      allow: { verify: ["Bash(make:*)"] },
      allowedDomains: ["*.workers.dev"],
    };
    const verify = runSettings({ stage: "verify" }, { worktree: "/w", runDir: "/r", profile });
    expect(verify.permissions.defaultMode).toBe("bypassPermissions");
    expect(verify.permissions.allow).toContain("Bash(make:*)");
    expect(verify.sandbox.network.allowedDomains).toContain("*.workers.dev");
    expect(verify.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(verify.permissions.deny).toContain("Bash(git push:*)");
    const build = runSettings({ stage: "build" }, { worktree: "/w", runDir: "/r", profile });
    expect(build.permissions.defaultMode).toBe("dontAsk");
    expect(build.permissions.allow).not.toContain("Bash(make:*)");
  });

  it("refuses runner hooks that could answer a permission decision", () => {
    const hook = [{ hooks: [{ type: "command" as const, command: "x" }] }];
    expect(() =>
      runSettings(
        { stage: "build" },
        { worktree: "/w", runDir: "/r", hooks: { PreToolUse: hook } },
      ),
    ).toThrow(/PreToolUse/);
    const ok = runSettings(
      { stage: "build" },
      { worktree: "/w", runDir: "/r", hooks: { Stop: hook } },
    );
    expect(ok.hooks?.Stop).toEqual(hook);
  });

  it("denies reads of protected paths", () => {
    const s = runSettings(
      { stage: "build" },
      { worktree: "/w", runDir: "/r", protectPaths: ["/Users/x/.config/sf"] },
    );
    expect(s.permissions.deny).toContain("Read(//Users/x/.config/sf/**)");
  });

  it("blanks credentials and isolates git in the environment", () => {
    const env = harnessEnv("/r/job", "/t/sf/job");
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_ACCESS_KEY_ID"]) {
      expect(env[name]).toBe("");
    }
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/r/job/gitconfig");
    expect(env.GH_CONFIG_DIR).toBe("/r/job/empty/gh");
    expect(env.NPM_CONFIG_USERCONFIG).toBe("/r/job/empty/npmrc");
    expect(env.npm_config_store_dir).toBe("/t/sf/pnpm-store");
  });
});

describe("launch", () => {
  it("launches Claude with the factory's flags per stage, never the user's settings", () => {
    for (const [stage, mode] of [
      ["triage", "dontAsk"],
      ["spec", "dontAsk"],
      ["build", "bypassPermissions"],
      ["verify", "dontAsk"],
    ] as const) {
      expect(
        claudeArgv(job(stage, { model: "model-for-implement" }), { settingsPath: "/r/s.json" }),
      ).toEqual([
        "claude",
        "--permission-mode",
        mode,
        "--setting-sources",
        "project,local",
        "--settings",
        "/r/s.json",
        "--strict-mcp-config",
        "--model",
        "model-for-implement",
      ]);
    }
    // The project's choice comes from the job's profile (its default-branch policy).
    const argv = claudeArgv(job("verify", { profile: { permissionMode: { verify: "plan" } } }), {
      settingsPath: "/s",
    });
    expect(argv[2]).toBe("plan");
    expect(argv.join(" ")).not.toMatch(/user/);
    expect(headlessArgs(job("build"), { settingsPath: "/s" }).slice(0, 2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("writes a launch script that records its pid and execs exactly the argv", () => {
    const record: LaunchRecord = {
      jobId: "job_1",
      stage: "build",
      mode: "bypassPermissions",
      argv: ["claude", "--permission-mode", "bypassPermissions", "--settings", "/r/it's.json"],
      settingsHash: "x",
      settingsPaths: [],
      pidFile: "/r/claude.pid",
      worktree: "/w/a b",
    };
    const script = launchScript(record, ["GH_TOKEN", "CLAUDE_CODE_PLUGIN_DIRS"]);
    expect(script).toContain("unset GH_TOKEN CLAUDE_CODE_PLUGIN_DIRS");
    expect(script).toContain("cd '/w/a b' || exit 97");
    expect(script).toContain("echo $$ > /r/claude.pid");
    expect(script).toContain(
      "exec claude --permission-mode bypassPermissions --settings '/r/it'\\''s.json'",
    );
  });

  it("finds a mismatch between the live process and the launch record", () => {
    const record: LaunchRecord = {
      jobId: "job_1",
      stage: "build",
      mode: "bypassPermissions",
      argv: [
        "claude",
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "project,local",
      ],
      settingsHash: "h",
      settingsPaths: ["/r/s.json", "/w/.claude/settings.local.json"],
      pidFile: "/r/claude.pid",
      worktree: "/w",
    };
    const hashes = { "/r/s.json": "h", "/w/.claude/settings.local.json": "h" };
    expect(
      launchProblems(record, {
        pid: 1,
        command: "claude --permission-mode bypassPermissions --setting-sources project,local",
        settingsHashes: hashes,
      }),
    ).toEqual([]);
    // Incident 2026-11-11 #6: the launcher put the owner's mode on the command line.
    const [problem] = launchProblems(record, {
      pid: 1,
      command: "claude --permission-mode auto",
      settingsHashes: hashes,
    });
    expect(problem).toMatch(/permission mode auto, expected bypassPermissions/);
    expect(
      launchProblems(record, {
        pid: 1,
        command: "claude --permission-mode bypassPermissions --setting-sources project,local",
        settingsHashes: { ...hashes, "/w/.claude/settings.local.json": "edited" },
      }),
    ).toEqual(["/w/.claude/settings.local.json changed since it was projected"]);
    expect(launchProblems(record, { pid: null, command: null, settingsHashes: hashes })).toEqual([
      "the launch script recorded no pid",
    ]);
  });
});

describe("projection", () => {
  it("writes the same settings to the run dir and the worktree, and a launch record that verifies", async () => {
    const worktree = await temp("sf-h-wt-");
    const runDir = join(await temp("sf-h-run-"), "job_1");
    const runTmp = join(await temp("sf-h-tmp-"), "job_1");
    const bin = await temp("sf-h-bin-");
    const claudeBin = join(bin, "claude");
    const projected = await projectHarness(job("build"), { worktree, runDir, runTmp, claudeBin });
    const local = await readFile(join(worktree, SETTINGS_FILE), "utf8");
    expect(await readFile(projected.settingsPath, "utf8")).toBe(local);
    expect(JSON.parse(local).permissions.defaultMode).toBe("bypassPermissions");
    expect(await readFile(projected.gitConfigPath, "utf8")).toContain("helper =");
    expect(projected.launch.argv).toContain(projected.settingsPath);
    expect(await readLaunchRecord(runDir)).toEqual(projected.launch);

    // Run the launch script with a stand-in `claude` that just sleeps: the check passes on the
    // real process, then fails once the settings are touched.
    await writeFile(claudeBin, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const child = spawn("/bin/sh", [projected.scriptPath], { stdio: "ignore" });
    try {
      let problems: string[] = ["not started"];
      for (let i = 0; i < 30 && problems.length; i++) {
        await new Promise((r) => setTimeout(r, 100));
        problems = await verifyLaunch(projected.launch, async (pid) => {
          const real = await psCommand(pid);
          // `sh` runs the stand-in script, so ps shows the interpreter first; strip it.
          return real?.replace(/^\/bin\/sh /, "") ?? null;
        });
      }
      expect(problems).toEqual([]);
      await writeFile(join(worktree, SETTINGS_FILE), "{}\n");
      expect(await verifyLaunch(projected.launch)).toContain(
        `${join(worktree, SETTINGS_FILE)} changed since it was projected`,
      );
    } finally {
      child.kill();
    }
  });

  it("gives git no way to push with the owner's credentials (criterion 8)", async () => {
    // A repo whose remote needs credentials, run with the harness env: git must fail without
    // prompting and without consulting a credential helper or the keychain.
    const worktree = await temp("sf-h-git-");
    const runDir = join(await temp("sf-h-run-"), "job_2");
    await projectHarness(job("build"), { worktree, runDir, runTmp: join(runDir, "tmp") });
    const env = scrubbedProcessEnv(process.env, harnessEnv(runDir));
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: worktree, env, encoding: "utf8", timeout: 30_000 });
    expect(git("init", "-q", "-b", "main").status).toBe(0);
    await writeFile(join(worktree, "a.txt"), "a\n");
    expect(git("add", "a.txt").status).toBe(0);
    const commit = git("commit", "-qm", "a");
    expect(commit.status).toBe(0);
    expect(git("log", "-1", "--format=%an <%ae>").stdout.trim()).toBe(
      "Software Factory <software-factory@users.noreply.github.com>",
    );
    expect(git("config", "--get-all", "credential.helper").stdout.trim()).toBe("");
    expect(git("config", "--show-origin", "--list").stdout).not.toMatch(/osxkeychain|gh auth/);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    const push = git("push", "https://github.com/timoconnellaus/software-factory.git", "HEAD:x");
    expect(push.status).not.toBe(0);
    // no credential helper ran, nothing was asked
    expect(push.stderr).toMatch(/could not read Username|terminal prompts disabled|denied|403/i);
  });

  it("keeps ANTHROPIC and CLAUDE variables but drops credentials", () => {
    const env = scrubbedProcessEnv(
      {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "k",
        CLAUDE_CONFIG_DIR: "/c",
        GH_TOKEN: "t",
        AWS_SECRET_ACCESS_KEY: "s",
        SSH_AUTH_SOCK: "/s",
        MY_SECRET: "x",
      },
      { GIT_CONFIG_NOSYSTEM: "1", GH_TOKEN: "" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CONFIG_DIR: "/c",
      GIT_CONFIG_NOSYSTEM: "1",
    });
  });
});

describe("transcripts", () => {
  const lines = [
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "12 passed", is_error: false },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "a" }] },
        ],
      },
    },
    { type: "assistant", message: { content: [{ type: "text", text: "All done." }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");

  it("pulls out commands, check output and the last message", () => {
    const summary = parseTranscript(lines);
    expect(summary.commands).toHaveLength(2);
    expect(summary.lastAssistantText).toBe("All done.");
    const log = checkOutputLog(summary);
    expect(log).toContain("$ pnpm test");
    expect(log).toContain("12 passed");
    expect(log).not.toContain("$ ls");
  });

  it("finds the newest transcript for a working directory", async () => {
    const root = await temp("sf-h-claude-");
    const cwd = "/Users/x/orca/workspaces/repo/sf-job.1";
    const dir = join(root, "projects", projectDirName(cwd));
    execFileSync("mkdir", ["-p", dir]);
    await writeFile(join(dir, "a.jsonl"), lines);
    expect(projectDirName(cwd)).toBe("-Users-x-orca-workspaces-repo-sf-job-1");
    expect(await findTranscript(cwd, { configDirs: [root] })).toBe(join(dir, "a.jsonl"));
    expect(await findTranscript(cwd, { configDirs: [root], since: Date.now() + 60_000 })).toBe(
      null,
    );
  });

  it("maps stream-json to contract events", () => {
    expect(streamJsonToEvents('{"type":"system","subtype":"init"}')).toEqual([
      { type: "agent.status", status: "working" },
    ]);
    const ended = streamJsonToEvents('{"type":"result","subtype":"success","result":"ok"}');
    expect(ended.at(-1)).toEqual({ type: "session.ended", outcome: "completed", summary: "ok" });
  });
});
