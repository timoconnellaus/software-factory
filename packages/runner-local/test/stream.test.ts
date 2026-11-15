// runner-local's stream-json session mode (spec 37, ADR 0450) against a scripted stand-in `claude`
// (src/testing.ts `fakeStreamClaude`), over real git and a real child process: the prompt as the
// first JSON message, events from the structured output, a result ending the job, and the launch
// check.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_CONFIG_MISMATCH,
  PROMPT_FILE,
  PROMPT_POINTER,
  readLaunchRecord,
  STREAM_FLAGS,
} from "@software-factory/harness-claude";
import { type AdapterEvent, type Job, RESULT_FILE } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalRunner, HarnessConfigMismatch, type LocalRunnerConfig } from "../src/index.ts";
import { type FakeStreamClaudeOptions, fakeStreamClaude, scriptedTmux } from "../src/testing.ts";

const URL = "https://github.com/acme/app.git";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    jobId: "job_1",
    runId: "run_1",
    runNo: 1,
    stage: "flow",
    workItem: { id: "wi_1", number: 7, title: "Add a line" },
    repo: { url: URL, owner: "acme", name: "app", baseRef: "factory/7-add-a-line" },
    branch: "factory/7-add-a-line-run-1",
    harness: { id: "claude-code", role: "implement", prompt: "add a line\n" },
    context: {},
    requires: [],
    limits: { sessionTimeoutMs: 10_000 },
    lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    ...overrides,
  };
}

async function world(
  fake: Omit<FakeStreamClaudeOptions, "stdinLog"> = {},
  extra: Partial<LocalRunnerConfig> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sf-stream-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  await mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "# scratch\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-qm", "init");
  git(seed, "branch", "factory/7-add-a-line");
  const clone = join(root, "repos", "acme", "app");
  git(root, "clone", "-q", seed, clone);
  const startSha = git(seed, "rev-parse", "factory/7-add-a-line");
  const stdinLog = join(root, "stdin.jsonl");
  const claudeBin = join(root, "bin", "claude.mjs");
  await mkdir(join(root, "bin"));
  await writeFile(claudeBin, fakeStreamClaude({ stdinLog, ...fake }), { mode: 0o755 });
  const tmux = scriptedTmux();
  const runsDir = join(root, "runs");
  const config: LocalRunnerConfig = {
    exec: tmux.exec,
    session: "stream-json",
    resolveRepoPath: () => clone,
    ownReposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    runsDir,
    startPoint: () => startSha,
    claudeBin,
    pollMs: 5,
    // `ps` shows exactly the launch record's argv: the harness started as set.
    readCommand: async () =>
      (await readLaunchRecord(join(runsDir, "job_1")))?.argv.join(" ") ?? null,
    ...extra,
  };
  return { root, runner: createLocalRunner(config), runsDir, stdinLog, config, tmux };
}

const stdinLines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown> & { message?: { content?: string } });

/** Drains events, calling `on` for each as it comes. */
async function drain(
  it: AsyncIterable<AdapterEvent>,
  on?: (e: AdapterEvent, all: AdapterEvent[]) => unknown,
) {
  const out: AdapterEvent[] = [];
  for await (const e of it) {
    out.push(e);
    await on?.(e, out);
  }
  return out;
}

const waitUntil = async (check: () => Promise<boolean> | boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("runner-local stream-json sessions", { timeout: 30_000 }, () => {
  it("declares chat in stream mode, and not in tmux", async () => {
    const w = await world();
    expect((await w.runner.manifest()).capabilities).toContain("chat");
    // No tmux pane to bridge: a stream session is taken over by resume, not the web terminal.
    expect((await w.runner.manifest()).capabilities).not.toContain("terminal");
    const tmuxRunner = createLocalRunner({ ...w.config, session: "tmux" });
    expect((await tmuxRunner.manifest()).capabilities).not.toContain("chat");
    // Even when `chat` is configured by hand, it follows the session mode.
    const configured = createLocalRunner({
      ...w.config,
      session: "tmux",
      capabilities: ["hooks", "chat"],
    });
    expect((await configured.manifest()).capabilities).toEqual(["hooks"]);
  });

  it("runs a build: the prompt as the first JSON message, events from the stream, a result ends it", async () => {
    const w = await world({ writeResult: true });
    const signal = new AbortController().signal;
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal);
    // The launch carries the stream flags and its own conversation id (ADR 0450, 0270).
    expect(ws.launch.argv.slice(-STREAM_FLAGS.length)).toEqual([...STREAM_FLAGS]);
    const sessionId = ws.launch.stream?.sessionId as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws.launch.argv[ws.launch.argv.indexOf("--session-id") + 1]).toBe(sessionId);
    expect(ws.launch.argv).toContain("--setting-sources");
    expect(ws.launch.argv).toContain("--strict-mcp-config");

    const session = await w.runner.startSession(j, ws, signal);
    expect(session.mode).toBe("stream");
    expect(session.takeover).toBeUndefined();
    expect((await w.runner.capacity()).inUse).toBe(1);
    // No tmux session: the stream is a child process.
    expect(w.tmux.calls.some((c) => c.includes("new-session"))).toBe(false);
    expect(await readFile(join(ws.path, PROMPT_FILE), "utf8")).toBe(j.harness.prompt);
    await waitUntil(async () => (await stdinLines(w.stdinLog)).length >= 1);
    const [first] = await stdinLines(w.stdinLog);
    expect(first).toMatchObject({
      type: "user",
      message: { role: "user", content: PROMPT_POINTER },
      session_id: sessionId,
    });

    const events = await drain(w.runner.events(j, session, signal));
    expect(events).toEqual([
      { type: "agent.status", status: "working" },
      { type: "message", role: "assistant", text: `Turn 1: ${PROMPT_POINTER.slice(0, 40)}` },
      { type: "tool", name: "Bash", input: '{"command":"echo 1"}', id: "tu_1" },
      { type: "tool.result", toolId: "tu_1", output: "out 1" },
      {
        type: "turn",
        outcome: "success",
        durationMs: 1200,
        turns: 2,
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      },
      { type: "agent.status", status: "done" },
      { type: "session.ended", outcome: "completed", summary: "Done with turn 1" },
    ]);
    expect(existsSync(join(ws.path, RESULT_FILE))).toBe(true);
    const pid = session.stream?.child.pid as number;
    await w.runner.release(j, ws, session);
    await w.runner.release(j, ws, session);
    await waitUntil(() => session.stream?.exited !== null);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(ws.path)).toBe(false);
    expect((await w.runner.capacity()).inUse).toBe(0);
  });

  it("a failed turn fails the build", async () => {
    const w = await world({ failFirst: true });
    const signal = new AbortController().signal;
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal);
    const session = await w.runner.startSession(j, ws, signal);
    const events = await drain(w.runner.events(j, session, signal));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn",
        outcome: "error",
        error: expect.stringMatching(/max_turns/),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "failed" });
    await w.runner.release(j, ws, session);
  });

  it("denies a permission request nobody would answer", async () => {
    const w = await world({ askPermission: true });
    const signal = new AbortController().signal;
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal);
    const session = await w.runner.startSession(j, ws, signal);
    await drain(w.runner.events(j, session, signal));
    const lines = await stdinLines(w.stdinLog);
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "perm-1",
          response: expect.objectContaining({ behavior: "deny" }),
        }),
      }),
    );
    await w.runner.release(j, ws, session);
  });

  it("ends when the process exits: completed with a result file, else failed", async () => {
    for (const [writeResult, outcome] of [
      [true, "completed"],
      [false, "failed"],
    ] as const) {
      const w = await world({ exitBeforeResult: true, writeResult });
      const j = job();
      const signal = new AbortController().signal;
      const ws = await w.runner.prepareWorkspace(j, signal);
      const session = await w.runner.startSession(j, ws, signal);
      const events = await drain(w.runner.events(j, session, signal));
      expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome });
      await w.runner.release(j, ws, session);
    }
  });

  it("kills a process that doesn't match its launch record before the prompt", async () => {
    const w = await world({}, { readCommand: async () => "claude --permission-mode default" });
    const signal = new AbortController().signal;
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal);
    const started = w.runner.startSession(j, ws, signal);
    await expect(started).rejects.toBeInstanceOf(HarnessConfigMismatch);
    await expect(started).rejects.toThrow(HARNESS_CONFIG_MISMATCH);
    // Nothing was sent: no prompt, no prompt file.
    expect(await stdinLines(w.stdinLog)).toEqual([]);
    expect(existsSync(join(ws.path, PROMPT_FILE))).toBe(false);
    expect((await w.runner.capacity()).inUse).toBe(0);
    await w.runner.release(j, ws, undefined);
  });
});
