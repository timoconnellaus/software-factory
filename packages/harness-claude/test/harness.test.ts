import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_FILE } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkOutputLog,
  findTranscript,
  harnessEnv,
  parseTranscript,
  projectDirName,
  projectHarness,
  runSettings,
  SETTINGS_FILE,
  scrubbedProcessEnv,
  streamJsonToEvents,
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

describe("run settings", () => {
  it("lets triage only read and write its result file", () => {
    const s = runSettings({ stage: "triage" }, { worktree: "/w/job", runDir: "/r/job" });
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(s.permissions.allow).toContain(`Write(//w/job/${RESULT_FILE})`);
    expect(s.permissions.allow).not.toContain("Write");
    expect(s.permissions.allow).not.toContain("Edit");
    expect(s.permissions.allow.some((r) => r.startsWith("Bash(pnpm"))).toBe(false);
  });

  it("lets verify run the toolchain but not edit", () => {
    const s = runSettings({ stage: "verify" }, { worktree: "/w/job", runDir: "/r/job" });
    expect(s.permissions.allow).toContain("Bash(pnpm:*)");
    expect(s.permissions.allow).not.toContain("Edit");
  });

  it("lets build edit and commit, never push", () => {
    const s = runSettings({ stage: "build" }, { worktree: "/w/job", runDir: "/r/job" });
    expect(s.permissions.allow).toEqual(
      expect.arrayContaining(["Edit", "Write", "Bash(git commit:*)"]),
    );
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        "Bash(git push:*)",
        "Bash(gh:*)",
        "Bash(git config:*)",
        "Bash(wrangler:*)",
        "Read(~/.ssh/**)",
        "Read(~/.config/gh/**)",
      ]),
    );
    expect(s.permissions.allow.some((r) => r.includes("git push"))).toBe(false);
  });

  it("lets the runner owner pick the mode per stage", () => {
    const s = runSettings(
      { stage: "build" },
      { worktree: "/w", runDir: "/r", permissionMode: { build: "auto" } },
    );
    expect(s.permissions.defaultMode).toBe("auto");
  });

  it("denies reads of protected paths", () => {
    const s = runSettings(
      { stage: "build" },
      { worktree: "/w", runDir: "/r", protectPaths: ["/Users/x/.config/sf"] },
    );
    expect(s.permissions.deny).toContain("Read(//Users/x/.config/sf/**)");
  });

  it("blanks credentials and isolates git in the environment", () => {
    const env = harnessEnv("/r/job");
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "AWS_ACCESS_KEY_ID"]) {
      expect(env[name]).toBe("");
    }
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/r/job/gitconfig");
    expect(env.GH_CONFIG_DIR).toBe("/r/job/empty/gh");
  });
});

describe("projection", () => {
  it("writes the settings into the worktree and the git config into the run dir", async () => {
    const worktree = await temp("sf-h-wt-");
    const runDir = join(await temp("sf-h-run-"), "job_1");
    const projected = await projectHarness({ stage: "build" }, { worktree, runDir });
    const written = JSON.parse(await readFile(join(worktree, SETTINGS_FILE), "utf8"));
    expect(written.permissions.defaultMode).toBe("dontAsk");
    expect(await readFile(projected.gitConfigPath, "utf8")).toContain("helper =");
  });

  it("gives git no way to push with the owner's credentials (criterion 8)", async () => {
    // A repo whose remote needs credentials, run with the harness env: git must fail without
    // prompting and without consulting a credential helper or the keychain.
    const worktree = await temp("sf-h-git-");
    const runDir = join(await temp("sf-h-run-"), "job_2");
    await projectHarness({ stage: "build" }, { worktree, runDir });
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
