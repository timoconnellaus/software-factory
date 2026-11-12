// runner-local with the real tmux (skipped when tmux isn't installed). A stand-in `claude` (a Node
// script) runs in the job's tmux session through the harness's real launch script: it shows the
// folder trust dialog, runs the projected status hook (the real one) on SessionStart, reads the
// prompt pointer from the terminal, works, and stops. The test drives the adapter end to end on its
// own tmux socket and checks that the owner's default tmux server is untouched.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROMPT_POINTER, psCommand } from "@software-factory/harness-claude";
import { type AdapterEvent, type Job, RESULT_FILE } from "@software-factory/runner-contract";
import { afterAll, describe, expect, it } from "vitest";
import { createLocalRunner, reapOrphans, tmuxCli } from "../src/index.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const SOCKET = `sf-test-${process.pid}`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

/** `tmux ls` on the owner's default server: read only (it never starts a server). */
const defaultLs = () => {
  const r = spawnSync("tmux", ["ls"], { encoding: "utf8" });
  return `${r.status}\n${r.stdout}`;
};

/**
 * The stand-in for Claude Code. It runs each hook command from the `--settings` file the way Claude
 * does (stdin JSON, through the shell), so the factory's real status hook writes the status file.
 */
const FAKE_CLAUDE = (node: string) => `#!${node}
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
const hook = (event, input = {}) => {
  for (const entry of settings.hooks?.[event] ?? []) {
    for (const h of entry.hooks) {
      spawnSync("/bin/sh", ["-c", h.command], {
        input: JSON.stringify({ hook_event_name: event, transcript_path: "/nonexistent.jsonl", ...input }),
      });
    }
  }
};
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const next = async () => (await lines.next()).value ?? "";
console.log("Quick safety check: do you trust the files in this folder?");
console.log("❯ 1. No, exit");
console.log("  2. Yes, I trust this folder");
const answer = await next();
if (!answer.includes("\\u001b[B") && !answer.includes("[B")) process.exit(3);
// Claude redraws: the dialog is gone from the screen once answered.
process.stdout.write("\u001b[2J\u001b[H");
console.log("trusted");
hook("SessionStart", { source: "startup" });
const prompt = await next();
hook("UserPromptSubmit", { prompt });
for (let i = 0; i < 80; i++) console.log("working line " + i);
hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "echo hello >> README.md" } });
appendFileSync("README.md", "hello\\n");
hook("PostToolUse", { tool_name: "Bash" });
writeFileSync("${RESULT_FILE}", JSON.stringify({ notes: "ok", prompt }));
// Steering (a person typing after takeover) reaches the agent before it stops.
const steer = await next();
writeFileSync("steered.txt", steer);
hook("UserPromptSubmit", { prompt: steer });
hook("Stop", {});
await new Promise(() => {});
`;

const cleanups: (() => Promise<void>)[] = [];
/** The test server's socket file, which tmux leaves behind when it exits. */
let socketPath = "";
afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
  spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
  if (socketPath.endsWith(`/${SOCKET}`)) await rm(socketPath, { force: true });
});

describe.skipIf(!hasTmux)("runner-local on the real tmux", { timeout: 60_000 }, () => {
  it("runs a session end to end, takes steering, releases cleanly, leaves the default server alone", async () => {
    const before = defaultLs();
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-tmux-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const seed = join(root, "projects", "app");
    await mkdir(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "remote", "add", "origin", "https://github.com/acme/app.git");
    await writeFile(join(seed, "README.md"), "# scratch\n");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-qm", "init");
    const claude = join(root, "bin", "claude");
    await mkdir(join(root, "bin"));
    await writeFile(claude, FAKE_CLAUDE(process.execPath));
    await chmod(claude, 0o755);
    const runsDir = join(root, "runs");
    const runner = createLocalRunner({
      checkouts: [join(root, "projects")],
      resolveRepoPath: () => {
        throw new Error("the owner's checkout should have been found");
      },
      worktreesDir: join(root, "worktrees"),
      runsDir,
      startPoint: () => "main",
      claudeBin: claude,
      pollMs: 50,
      screenLogMs: 0,
      tmux: { socket: SOCKET },
      // `ps` shows `<node> <script> <args>` for a script: drop the interpreter, check the rest.
      readCommand: async (pid) => (await psCommand(pid))?.replace(/^\S+\s+/, "") ?? null,
    });
    const j: Job = {
      jobId: "job_tmux1",
      runId: "run_1",
      runNo: 1,
      stage: "build",
      workItem: { id: "wi_1", number: 7, title: "Add a line" },
      repo: { url: "https://github.com/acme/app.git", owner: "acme", name: "app", baseRef: "main" },
      branch: "factory/7-add-a-line-run-1",
      harness: { id: "claude-code", role: "implement", prompt: "add a line" },
      context: {},
      requires: [],
      limits: { sessionTimeoutMs: 30_000 },
      lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    };
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(j, signal);
    expect(ws.checkout).toBe(seed);
    const session = await runner.startSession(j, ws, signal);
    expect(session.takeover?.hint).toBe(`tmux -L ${SOCKET} attach -t sf-job_tmux1`);
    expect((await runner.capacity()).inUse).toBe(1);
    socketPath = spawnSync("tmux", ["-L", SOCKET, "display-message", "-p", "#{socket_path}"], {
      encoding: "utf8",
    }).stdout.trim();

    // A person types into the live session (what `tmux attach` does), and it reaches the agent.
    const events: AdapterEvent[] = [];
    const steered = (async () => {
      for (let i = 0; i < 100 && !existsSync(join(ws.path, RESULT_FILE)); i++) await sleep(50);
      await runner.steer?.(session, "also say thanks");
    })();
    for await (const e of runner.events(j, session, signal)) events.push(e);
    await steered;
    const kinds = events.filter((e) => e.type !== "log");
    expect(kinds).toEqual([
      { type: "agent.status", status: "working" },
      {
        type: "tool",
        name: "Bash",
        input: JSON.stringify({ command: "echo hello >> README.md" }),
      },
      { type: "agent.status", status: "done" },
      { type: "session.ended", outcome: "completed" },
    ]);
    expect(events.some((e) => e.type === "log" && e.text.includes("working line"))).toBe(true);
    const result = JSON.parse(await readFile(join(ws.path, RESULT_FILE), "utf8"));
    expect(result.prompt).toBe(PROMPT_POINTER);
    expect(await readFile(join(ws.path, "steered.txt"), "utf8")).toBe("also say thanks");
    const artifacts = await runner.collectArtifacts(j, ws, session);
    expect(artifacts.find((a) => a.kind === "log" && a.name === "terminal-screen")).toBeTruthy();

    await runner.release(j, ws, session);
    await runner.release(j, ws, session);
    expect(existsSync(ws.path)).toBe(false);
    expect(await tmuxCli({ socket: SOCKET }).paneState("sf-job_tmux1")).toBeNull();
    expect(git(seed, "branch", "--list", j.branch)).toBe("");
    expect(existsSync(join(runsDir, j.jobId))).toBe(false);
    expect(defaultLs()).toBe(before);
  });

  it("reaps a session left by a killed host", async () => {
    const tmux = tmuxCli({ socket: SOCKET });
    await tmux.newSession({ name: "sf-job_orphan", cwd: tmpdir(), command: "sleep 60" });
    await tmux.newSession({ name: "sf-job_live", cwd: tmpdir(), command: "sleep 60" });
    const root = await mkdtemp(join(tmpdir(), "sf-reap-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const reaped = await reapOrphans(
      {
        worktreesDir: join(root, "worktrees"),
        runsDir: join(root, "runs"),
        tmux: { socket: SOCKET },
      },
      new Set(["job_live"]),
    );
    expect(reaped).toEqual(["job_orphan"]);
    expect((await tmux.jobSessions()).map((s) => s.name)).toEqual(["sf-job_live"]);
    await tmux.kill("sf-job_live");
  });
});
