import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeArgv,
  findTranscript,
  harnessEnv,
  headlessArgs,
  type LaunchRecord,
  launchProblems,
  launchScript,
  parseStatusLines,
  parseTranscript,
  procCommand,
  projectDirName,
  projectHarness,
  psCommand,
  readLaunchRecord,
  readStatusFrom,
  readTranscriptFrom,
  runSettings,
  SETTINGS_FILE,
  STATUS_FILE,
  STATUS_HOOK_EVENTS,
  scrubbedProcessEnv,
  streamJsonToEvents,
  verifyLaunch,
} from "../src/index.ts";

// The factory's own verify runs these tests inside the harness's sandbox, where spawning `ps`
// fails (EPERM, thrown, not returned) and github.com is reached only through the sandbox's proxy.
// The two tests that need a real process table and a direct GitHub connection skip there. Never in
// CI: a broken `ps` there must fail, not skip, the credential-push test (ADR 0010/0033).
const inHarnessSandbox =
  !process.env.CI &&
  (await psCommand(process.pid).then(
    (line) => line === null,
    () => true,
  ));

const dirs: string[] = [];
const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A flow job's repository and item branch: the job then works in a worktree. */
const REPO = {
  repo: {
    url: "https://github.com/acme/app.git",
    owner: "acme",
    name: "app",
    baseRef: "main",
    defaultBranch: "main",
  },
  branch: "factory/flow-acm-7",
};

/** A flow job in a plain directory, or (`repo`) in a worktree of its repository. */
const job = (kind: "plain" | "repo" = "plain", harness: Partial<Job["harness"]> = {}) => ({
  jobId: "job_1",
  stage: "flow" as const,
  harness: { id: "claude-code" as const, role: "implement" as const, prompt: "p", ...harness },
  ...(kind === "repo" ? REPO : {}),
});

describe("run settings", () => {
  it("lets a flow job read and write only in its own directory, with no git, in dontAsk", () => {
    const s = runSettings({}, { worktree: "/tmp/flow/job", runDir: "/r/job" });
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(s.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Write(//tmp/flow/job/**)", "Edit(//tmp/flow/job/**)"]),
    );
    expect(s.permissions.allow).not.toContain("Write");
    expect(s.permissions.allow).not.toContain("Edit");
    expect(s.permissions.allow.some((r) => r.startsWith("Bash(git"))).toBe(false);
    expect(s.permissions.allow.some((r) => r.startsWith("Bash(pnpm"))).toBe(false);
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(false);
    // WebFetch only to the allowlist.
    expect(s.permissions.allow).not.toContain("WebFetch");
    expect(s.permissions.allow).toContain("WebFetch(domain:registry.npmjs.org)");
  });

  it("passes a flow job's model and effort to the CLI, and drops an effort it doesn't know", () => {
    const flow = (harness: Partial<Job["harness"]>) => ({
      harness: { id: "claude-code" as const, role: "implement" as const, prompt: "p", ...harness },
    });
    const argv = claudeArgv(flow({ model: "sonnet", effort: "xhigh" }), { settingsPath: "/s" });
    expect(argv.join(" ")).toContain("--model sonnet --effort xhigh");
    expect(claudeArgv(flow({ effort: "turbo" }), { settingsPath: "/s" })).not.toContain("--effort");
    const plain = claudeArgv(flow({}), { settingsPath: "/s" });
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--effort");
  });

  it("gives a flow job with a repository edits, the shell and git commit, never a push", () => {
    const options = { worktree: "/w/job", runDir: "/r/job", platform: "darwin" as const };
    const s = runSettings(REPO, options);
    expect(s.permissions.defaultMode).toBe("bypassPermissions");
    expect(s.permissions.allow).toEqual(
      expect.arrayContaining(["Edit", "Write", "Bash(git commit:*)", "Bash(pnpm:*)"]),
    );
    expect(s.permissions.deny).toContain("Bash(git push:*)");
    expect(s.permissions.allow.some((r) => r.includes("git push"))).toBe(false);
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(true);
    // The launch's --permission-mode follows.
    const argv = claudeArgv(job("repo"), { settingsPath: "/r/job/settings.json" });
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    // Without a repository: the plain directory's rules.
    const plain = claudeArgv(job(), { settingsPath: "/r/job/settings.json" });
    expect(plain[plain.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(runSettings({}, options).permissions.allow).not.toContain("Edit");
  });

  it("runs a repository's job in bypassPermissions inside the sandbox, never pushing", () => {
    const s = runSettings(REPO, { worktree: "/w/job", runDir: "/r/job", platform: "darwin" });
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

  it("denies writes with Edit(...) rules only, never a Write(...) deny that can't match", () => {
    for (const kind of [{}, REPO]) {
      const s = runSettings(kind, { worktree: "/w/job", runDir: "/r/job", platform: "darwin" });
      expect(s.permissions.deny.filter((r) => r.startsWith("Write("))).toEqual([]);
      expect(s.permissions.deny).toEqual(
        expect.arrayContaining([
          "Edit(~/.ssh)",
          "Edit(~/.ssh/**)",
          "Edit(//w/job/.claude)",
          "Edit(//w/job/.claude/**)",
          "Edit(.git/**)",
        ]),
      );
    }
  });

  it("in a container, runs every job in bypassPermissions with Claude's own sandbox off (ADR 0661)", () => {
    for (const kind of [{}, REPO]) {
      const s = runSettings(kind, { worktree: "/w/job", runDir: "/r/job", isolation: "container" });
      expect(s.permissions.defaultMode).toBe("bypassPermissions");
      expect(s.skipDangerousModePermissionPrompt).toBe(true);
      expect(s.sandbox).toMatchObject({ enabled: false, failIfUnavailable: false });
      expect(
        claudeArgv(
          { ...kind, harness: { id: "claude-code", role: "implement", prompt: "" } },
          { settingsPath: "/r/job/s.json", mode: s.permissions.defaultMode },
        ),
      ).toContain("bypassPermissions");
    }
  });

  it("turns the sandbox on in every run, with no way to run unsandboxed", () => {
    for (const kind of [{}, REPO]) {
      const s = runSettings(kind, {
        worktree: "/w/job",
        runDir: "/r/job",
        runTmp: "/t/job",
        tempDirs: ["/tmp"],
        platform: "darwin",
        protectPaths: ["/home/me/.config/software-factory", "/home/me/checkout"],
        git: {
          commonDir: "/home/me/checkout/.git",
          gitDir: "/home/me/checkout/.git/worktrees/job",
        },
      });
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

  it("refuses runner hooks that could answer a permission decision", () => {
    const hook = [{ hooks: [{ type: "command" as const, command: "x" }] }];
    expect(() =>
      runSettings(REPO, { worktree: "/w", runDir: "/r", hooks: { PreToolUse: hook } }),
    ).toThrow(/PreToolUse/);
    const ok = runSettings(REPO, { worktree: "/w", runDir: "/r", hooks: { Stop: hook } });
    expect(ok.hooks?.Stop).toEqual(hook);
  });

  it("adds the factory's status hook on every status event, PreToolUse included (ADR 0380)", () => {
    const hook = [{ hooks: [{ type: "command" as const, command: "x" }] }];
    const s = runSettings(REPO, {
      worktree: "/w",
      runDir: "/r",
      statusHook: "status-cmd",
      hooks: { Stop: hook },
    });
    expect(Object.keys(s.hooks ?? {}).sort()).toEqual([...STATUS_HOOK_EVENTS].sort());
    expect(s.hooks?.PreToolUse).toEqual([
      { hooks: [{ type: "command", command: "status-cmd", timeout: 10 }] },
    ]);
    // The runner's own hooks stay, the status hook after them.
    expect(s.hooks?.Stop?.map((h) => h.hooks[0]?.command)).toEqual(["x", "status-cmd"]);
    expect(s.hooks?.PermissionRequest).toBeUndefined();
    expect(s.permissions.deny).toContain("Bash(tmux:*)");
    expect(s.permissions.deny).toContain("Bash(orca:*)");
  });

  it("the status hook appends one line per event and always answers {} with exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-status-"));
    dirs.push(dir);
    const projected = await projectHarness(
      {
        stage: "flow",
        jobId: "job_s",
        harness: { id: "claude-code", role: "implement", prompt: "p" },
      },
      {
        worktree: join(dir, "wt"),
        runDir: join(dir, "run"),
        runTmp: join(dir, "tmp"),
        statusHook: true,
      },
    );
    expect(projected.statusFile).toBe(join(dir, "run", STATUS_FILE));
    const command = projected.settings.hooks?.PreToolUse?.[0]?.hooks[0]?.command ?? "";
    const runHook = (input: string) =>
      spawnSync("/bin/sh", ["-c", command], { input, encoding: "utf8" });
    const long = "y".repeat(10_000);
    for (const input of [
      JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        transcript_path: "/t.jsonl",
      }),
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: long },
      }),
      JSON.stringify({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      }),
      "not json at all",
      "",
    ]) {
      const r = runHook(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("{}\n");
    }
    const lines = parseStatusLines(await readFile(projected.statusFile ?? "", "utf8"));
    expect(lines.map((l) => l.event)).toEqual([
      "SessionStart",
      "PreToolUse",
      "Notification",
      "unknown",
    ]);
    expect(lines[0]).toMatchObject({ reason: "startup", transcript: "/t.jsonl" });
    expect(lines[1]?.tool).toBe("Bash");
    expect(lines[1]?.input?.length).toBeLessThan(2_100);
    expect(lines[2]).toMatchObject({ type: "permission_prompt" });
    // Read incrementally, as the adapter tails it.
    const first = await readStatusFrom(projected.statusFile ?? "", 0);
    expect(first.lines).toHaveLength(4);
    expect((await readStatusFrom(projected.statusFile ?? "", first.offset)).lines).toEqual([]);
  });

  it("denies Linux's credential stores on Linux and macOS's keychain on macOS (ADR 0420)", () => {
    const linux = runSettings(REPO, { worktree: "/w", runDir: "/r", platform: "linux" });
    const mac = runSettings(REPO, { worktree: "/w", runDir: "/r", platform: "darwin" });
    for (const p of [".local/share/keyrings", ".password-store", ".claude/.credentials.json"]) {
      expect(linux.permissions.deny).toContain(`Read(~/${p})`);
      expect(linux.permissions.deny).toContain(`Read(~/${p}/**)`);
      expect(linux.sandbox.filesystem.denyRead).toContain(`~/${p}`);
      expect(linux.sandbox.filesystem.denyWrite).toContain(`~/${p}`);
    }
    expect(JSON.stringify(linux)).not.toContain("Library");
    expect(linux.sandbox.filesystem.allowWrite).not.toContain("/private/tmp");
    expect(linux.sandbox.filesystem.allowWrite).toContain("/tmp");
    expect(linux.permissions.deny).toEqual(
      expect.arrayContaining(["Bash(systemctl:*)", "Bash(loginctl:*)", "Bash(secret-tool:*)"]),
    );
    expect(mac.permissions.deny).toContain("Read(~/Library/Keychains/**)");
    expect(mac.permissions.deny).toContain("Read(~/.claude/.credentials.json)");
    expect(mac.sandbox.filesystem.allowWrite).toContain("/private/tmp");
    expect(mac.permissions.deny).not.toContain("Read(~/.local/share/keyrings)");
  });

  it("reads a live process's command line from /proc on Linux (no procps, ADR 0420)", async () => {
    const line = await procCommand(process.pid);
    if (process.platform !== "linux") {
      expect(line).toBeNull();
      return;
    }
    expect(line?.split(" ")[0]).toBe(
      readFileSync(`/proc/${process.pid}/cmdline`, "utf8").split("\0")[0],
    );
    // The same string procps prints, where procps is installed.
    const ps = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(process.pid)], {
      encoding: "utf8",
    });
    if (ps.status === 0) expect(line).toBe(ps.stdout.replace(/\n$/, ""));
    expect(await procCommand(2 ** 22 + 7)).toBeNull();
  });

  it("denies reads of protected paths", () => {
    const s = runSettings(REPO, {
      worktree: "/w",
      runDir: "/r",
      protectPaths: ["/Users/x/.config/sf"],
    });
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
  it("launches Claude with the factory's flags, never the user's settings", () => {
    for (const [kind, mode] of [
      ["plain", "dontAsk"],
      ["repo", "bypassPermissions"],
    ] as const) {
      expect(
        claudeArgv(job(kind, { model: "model-for-implement" }), { settingsPath: "/r/s.json" }),
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
    expect(claudeArgv(job(), { settingsPath: "/s" }).join(" ")).not.toMatch(/user/);
    expect(headlessArgs(job("repo"), { settingsPath: "/s" }).slice(0, 2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("writes a launch script that records its pid and execs exactly the argv", () => {
    const record: LaunchRecord = {
      jobId: "job_1",
      stage: "flow",
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
      stage: "flow",
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
  it.skipIf(inHarnessSandbox)(
    "writes the same settings to the run dir and the worktree, and a launch record that verifies",
    async () => {
      const worktree = await temp("sf-h-wt-");
      const runDir = join(await temp("sf-h-run-"), "job_1");
      const runTmp = join(await temp("sf-h-tmp-"), "job_1");
      const bin = await temp("sf-h-bin-");
      const claudeBin = join(bin, "claude");
      const projected = await projectHarness(job("repo"), { worktree, runDir, runTmp, claudeBin });
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
    },
  );

  it.skipIf(inHarnessSandbox)(
    "gives git no way to push with the owner's credentials (criterion 8)",
    async () => {
      // A repo whose remote needs credentials, run with the harness env: git must fail without
      // prompting and without consulting a credential helper or the keychain.
      const worktree = await temp("sf-h-git-");
      const runDir = join(await temp("sf-h-run-"), "job_2");
      await projectHarness(job("repo"), { worktree, runDir, runTmp: join(runDir, "tmp") });
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
    },
  );

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

  it("pulls out commands and the last message", () => {
    const summary = parseTranscript(lines);
    expect(summary.commands).toHaveLength(2);
    expect(summary.lastAssistantText).toBe("All done.");
  });

  it("finds the newest transcript for a working directory", async () => {
    const root = await temp("sf-h-claude-");
    const cwd = "/Users/x/work/worktrees/repo/sf-job.1";
    const dir = join(root, "projects", projectDirName(cwd));
    execFileSync("mkdir", ["-p", dir]);
    await writeFile(join(dir, "a.jsonl"), lines);
    expect(projectDirName(cwd)).toBe("-Users-x-work-worktrees-repo-sf-job-1");
    expect(await findTranscript(cwd, { configDirs: [root] })).toBe(join(dir, "a.jsonl"));
    expect(await findTranscript(cwd, { configDirs: [root], since: Date.now() + 60_000 })).toBe(
      null,
    );
  });

  it("reads a live transcript's assistant texts from an offset, leaving a partial line (ADR 0400)", async () => {
    const root = await temp("sf-h-live-");
    const path = join(root, "t.jsonl");
    await writeFile(path, `${lines}\n{"type":"assistant","message":{"content":[{"type":"te`);
    const firstRead = await readTranscriptFrom(path, 0);
    expect(firstRead.messages.map((m) => m.text)).toEqual(["All done."]);
    // The partial line is left for the next read.
    await writeFile(
      path,
      `${lines}\n${JSON.stringify({ type: "assistant", timestamp: "2026-11-12T00:00:00Z", message: { content: [{ type: "text", text: "Now the tests." }] } })}\n`,
    );
    const next = await readTranscriptFrom(path, firstRead.offset);
    expect(next.messages).toEqual([
      { role: "assistant", text: "Now the tests.", at: Date.parse("2026-11-12T00:00:00Z") },
    ]);
    expect((await readTranscriptFrom(path, next.offset)).messages).toEqual([]);
    // A missing file reads as nothing yet.
    expect(await readTranscriptFrom(join(root, "none.jsonl"), 0)).toEqual({
      messages: [],
      offset: 0,
    });
  });

  it("maps stream-json to contract events", () => {
    expect(streamJsonToEvents('{"type":"system","subtype":"init"}')).toEqual([
      { type: "agent.status", status: "working" },
    ]);
    const ended = streamJsonToEvents('{"type":"result","subtype":"success","result":"ok"}');
    expect(ended.at(-1)).toEqual({ type: "session.ended", outcome: "completed", summary: "ok" });
  });
});

describe("a flow job's MCP servers (spec 70 milestone 2)", () => {
  const server = {
    name: "factory",
    url: "https://engine.example.com/flow/mcp",
    headers: { authorization: "Bearer flow-secret" },
  };

  it("writes them as HTTP servers into the run dir, allows exactly their tools, hides the file", async () => {
    const worktree = await temp("sf-wt-");
    const runDir = await temp("sf-run-");
    const projected = await projectHarness(
      { ...job(), mcpServers: [server] },
      { worktree, runDir, runTmp: join(runDir, "tmp") },
    );
    const path = join(runDir, "mcp.json");
    const argv = projected.launch.argv;
    expect(argv.slice(argv.indexOf("--mcp-config"), argv.indexOf("--mcp-config") + 2)).toEqual([
      "--mcp-config",
      path,
    ]);
    expect(argv).toContain("--strict-mcp-config");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: {
        factory: { type: "http", url: server.url, headers: server.headers },
      },
    });
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const settings = projected.settings;
    expect(settings.permissions.allow.filter((r) => r.startsWith("mcp__"))).toEqual([
      "mcp__factory__*",
    ]);
    expect(settings.permissions.deny).toContain(`Read(/${path})`);
    // The token is only in the MCP config: not the settings, the launch record or the script.
    for (const file of [
      projected.settingsPath,
      projected.localSettingsPath,
      projected.scriptPath,
      join(runDir, "launch.json"),
    ]) {
      const text = await readFile(file, "utf8").catch(() => "");
      expect(text, file).not.toContain("flow-secret");
    }
    expect(JSON.stringify(projected)).not.toContain("flow-secret");
  });

  it("gives a job without servers none", async () => {
    for (const j of [job(), job("repo")]) {
      const runDir = await temp("sf-run-");
      const projected = await projectHarness(j, { worktree: await temp("sf-wt-"), runDir });
      expect(projected.launch.argv).not.toContain("--mcp-config");
      expect(projected.settings.permissions.allow.some((r) => r.startsWith("mcp__"))).toBe(false);
      await expect(readFile(join(runDir, "mcp.json"))).rejects.toThrow();
    }
  });

  it("refuses a server name that would widen its allow rule", async () => {
    await expect(
      projectHarness(
        { ...job(), mcpServers: [{ ...server, name: "*" }] },
        { worktree: await temp("sf-wt-"), runDir: await temp("sf-run-") },
      ),
    ).rejects.toThrow(/MCP server name/);
  });
});

describe("usage from the transcript (spec 09 M3)", () => {
  it("sums tokens per model, counting a streamed message once, and the wall time", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const msg = (id: string, model: string, usage: Record<string, number>, timestamp: string) => ({
      type: "assistant",
      timestamp,
      message: { id, model, usage, content: [{ type: "text", text: "hi" }] },
    });
    const jsonl = [
      line({ type: "user", timestamp: "2026-11-12T00:00:00.000Z", message: { content: "go" } }),
      line(
        msg(
          "m1",
          "model-a",
          { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5 },
          "2026-11-12T00:00:01.000Z",
        ),
      ),
      // The same message again (streamed): not counted twice.
      line(
        msg(
          "m1",
          "model-a",
          { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5 },
          "2026-11-12T00:00:01.500Z",
        ),
      ),
      line(
        msg("m2", "model-a", { input_tokens: 50, output_tokens: 5 }, "2026-11-12T00:00:30.000Z"),
      ),
      line(
        msg(
          "m3",
          "model-b",
          { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 2 },
          "2026-11-12T00:01:00.000Z",
        ),
      ),
    ].join("\n");
    const summary = parseTranscript(jsonl);
    expect(summary.usage).toEqual([
      {
        model: "model-a",
        inputTokens: 150,
        outputTokens: 15,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
      },
      {
        model: "model-b",
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 2,
      },
    ]);
    expect(summary.wallMs).toBe(60_000);
  });
});
