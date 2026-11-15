// runner-local against a scripted tmux (src/testing.ts) over real git: the workspace in the owner's
// checkout, the launch and its check, the prompt as a file, status from the hook file, takeover,
// release and reaping.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROMPT_FILE,
  PROMPT_POINTER,
  readLaunchRecord,
  SETTINGS_FILE,
  STATUS_HOOK_EVENTS,
} from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  type Job,
  RESULT_FILE,
  type RepoJob,
} from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRunningHarness,
  createLocalRunner,
  diagnose,
  isWaitingNotification,
  type LocalRunnerConfig,
  reapOrphans,
  scanCheckouts,
  sessionName,
  tmuxAtLeast,
} from "../src/index.ts";
import { type ScriptedTmuxOptions, scriptedTmux } from "../src/testing.ts";

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

function job(overrides: Partial<RepoJob> = {}): RepoJob {
  return {
    jobId: "job_1",
    runId: "run_1",
    runNo: 1,
    stage: "flow",
    workItem: { id: "wi_1", number: 7, title: "Add a line" },
    repo: { url: URL, owner: "acme", name: "app", baseRef: "factory/7-add-a-line" },
    branch: "factory/7-add-a-line-run-1",
    harness: { id: "claude-code", role: "implement", prompt: "add a line\n".repeat(500) },
    context: {},
    requires: [],
    limits: { sessionTimeoutMs: 10_000 },
    lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    ...overrides,
  };
}

/** A bare "GitHub", the owner's checkout of it under `projects/`, and the runner's dirs. */
async function world(
  tmuxOptions: ScriptedTmuxOptions = {},
  extra: Partial<LocalRunnerConfig> = {},
  options: { ownerCheckout?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sf-local-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  await mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "# scratch\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-qm", "init");
  git(seed, "branch", "factory/7-add-a-line");
  const bare = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", seed, bare);
  const projects = join(root, "projects");
  await mkdir(projects);
  let owner: string | null = null;
  if (options.ownerCheckout ?? true) {
    owner = join(projects, "app");
    git(root, "clone", "-q", bare, owner);
    git(owner, "remote", "set-url", "origin", URL);
    await writeFile(join(owner, ".env"), "OWNER_SECRET=1\n");
    git(owner, "checkout", "-q", "-b", "owner-work");
    await writeFile(join(owner, "WIP.txt"), "uncommitted\n");
  }
  // Another repo next to it, for another remote, and a plain folder.
  git(root, "clone", "-q", bare, join(projects, "other"));
  git(join(projects, "other"), "remote", "set-url", "origin", "git@github.com:acme/other.git");
  await mkdir(join(projects, "notes"));
  const clone = join(root, "repos", "acme", "app");
  const startSha = git(bare, "rev-parse", "factory/7-add-a-line");
  const tmux = scriptedTmux(tmuxOptions);
  const runsDir = join(root, "runs");
  const config: LocalRunnerConfig = {
    exec: tmux.exec,
    checkouts: [projects],
    resolveRepoPath: () => {
      if (!existsSync(clone)) git(root, "clone", "-q", bare, clone);
      return clone;
    },
    ownReposDir: join(root, "repos"),
    worktreesDir: join(root, "worktrees"),
    runsDir,
    startPoint: () => startSha,
    pollMs: 2,
    screenLogMs: 0,
    // `ps` shows exactly the launch record's argv: the harness started as set.
    readCommand: async () =>
      (await readLaunchRecord(join(runsDir, "job_1")))?.argv.join(" ") ?? null,
    ...extra,
  };
  const runner = createLocalRunner(config);
  return { root, bare, owner, clone, tmux, runner, runsDir, config, startSha };
}

async function drain(it: AsyncIterable<AdapterEvent>) {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const ownerState = (owner: string) => ({
  head: git(owner, "rev-parse", "HEAD"),
  branch: git(owner, "branch", "--show-current"),
  branches: git(owner, "branch", "--list"),
  status: git(owner, "status", "--porcelain"),
  remote: git(owner, "remote", "-v"),
  config: execFileSync("cat", [join(owner, ".git", "config")], { encoding: "utf8" }),
});

describe("runner-local adapter", { timeout: 30_000 }, () => {
  it("declares hooks, takeover and own hardware; no browser, no auto-register", async () => {
    const { runner } = await world();
    const m = await runner.manifest();
    expect(m.runnerKind).toBe("local");
    expect([...m.capabilities].sort()).toEqual(["hooks", "own-hardware", "ui-takeover"]);
  });

  it("runs a job: a worktree of the owner's checkout, tmux on its own socket, status from the hook file, clean release", async () => {
    const w = await world({
      onPrompt: (_s, append) => {
        append({ event: "PreToolUse", tool: "Edit", input: '{"file_path":"README.md"}' });
        append({ event: "PostToolUse", tool: "Edit" });
        append({ event: "Stop" });
      },
    });
    const owner = w.owner as string;
    const before = ownerState(owner);
    const signal = new AbortController().signal;
    const j = job();

    expect(await w.runner.resolveCheckout?.(j)).toBe(await realpathOf(owner));
    const ws = await w.runner.prepareWorkspace(j, signal);
    expect(ws.checkout).toBe(await realpathOf(owner));
    expect(ws.path).toBe(join(await realpathOf(join(w.root, "worktrees")), "sf-job_1"));
    expect(ws.branch).toBe(j.branch);
    expect(git(ws.path, "branch", "--show-current")).toBe(j.branch);
    expect(ws.baseSha).toBe(w.startSha);

    // The projected settings: the factory's status hook on every status event, tmux denied.
    const settings = JSON.parse(await readFile(join(ws.path, SETTINGS_FILE), "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual([...STATUS_HOOK_EVENTS].sort());
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("status-hook.mjs");
    expect(settings.hooks.PermissionRequest).toBeUndefined();
    expect(settings.permissions.deny).toContain("Bash(tmux:*)");
    expect(settings.permissions.deny).toContain("Bash(git push:*)");
    // The owner's checkout is protected; its git dir is writable for the run's own git only.
    expect(settings.sandbox.filesystem.denyRead).toContain(await realpathOf(owner));
    expect(settings.sandbox.filesystem.allowWrite).toContain(
      `${await realpathOf(owner)}/.git/objects`,
    );
    const exclude = await readFile(join(owner, ".git", "info", "exclude"), "utf8");
    for (const f of [SETTINGS_FILE, RESULT_FILE, PROMPT_FILE]) {
      expect(exclude.split("\n")).toContain(`/${f}`);
    }

    const session = await w.runner.startSession(j, ws, signal);
    expect(session.name).toBe("sf-job_1");
    expect(session.takeover).toEqual({
      label: "Attach in a terminal",
      hint: "tmux -L software-factory attach -t sf-job_1",
    });
    expect((await w.runner.capacity()).inUse).toBe(1);
    // Every tmux call goes to the factory's own socket, without the owner's config.
    expect([...w.tmux.sockets]).toEqual(["software-factory"]);
    expect(
      w.tmux.calls.every((c) => c.slice(0, 4).join(" ") === "-L software-factory -f /dev/null"),
    ).toBe(true);
    const create = w.tmux.calls.find((c) => c.includes("new-session")) ?? [];
    expect(create).toContain(`exec /bin/sh ${join(w.runsDir, "job_1", "launch.sh")}`);
    expect(create[create.indexOf("-c") + 1]).toBe(ws.path);

    // The prompt went in a file; the terminal only got the one-line pointer.
    expect(await readFile(join(ws.path, PROMPT_FILE), "utf8")).toBe(j.harness.prompt);
    const fake = w.tmux.sessions.get("sf-job_1");
    expect(fake?.submitted).toEqual([PROMPT_POINTER]);
    const typed = w.tmux.calls.filter((c) => c.includes("-l"));
    expect(typed.map((c) => c.at(-1))).toEqual([PROMPT_POINTER]);

    const events = await drain(w.runner.events(j, session, signal));
    expect(events.filter((e) => e.type !== "log")).toEqual([
      { type: "agent.status", status: "working" },
      { type: "tool", name: "Edit", input: '{"file_path":"README.md"}' },
      { type: "agent.status", status: "done" },
      { type: "session.ended", outcome: "completed" },
    ]);

    const artifacts = await w.runner.collectArtifacts(j, ws, session);
    expect(artifacts.every((a) => a.kind !== "diff")).toBe(true); // the host takes the diff
    expect(artifacts.some((a) => a.kind === "log" && a.name === "terminal-screen")).toBe(true);

    // Release, twice: no worktree, no session, no local run branch, no run dir.
    await w.runner.release(j, ws, session);
    await expect(w.runner.release(j, ws, session)).resolves.toBeUndefined();
    expect(existsSync(ws.path)).toBe(false);
    expect(w.tmux.sessions.has("sf-job_1")).toBe(false);
    expect(git(owner, "branch", "--list", j.branch)).toBe("");
    expect(git(owner, "worktree", "list").split("\n")).toHaveLength(1);
    expect(existsSync(join(w.runsDir, "job_1"))).toBe(false);
    expect((await w.runner.capacity()).inUse).toBe(0);

    // The owner's checkout: same branch, head, uncommitted work, branches, remotes and config.
    expect(ownerState(owner)).toEqual(before);
  });

  it("uses the host's own clone when no checkout has the remote", async () => {
    const w = await world({}, {}, { ownerCheckout: false });
    const j = job();
    expect(await w.runner.resolveCheckout?.(j)).toBeNull();
    const ws = await w.runner.prepareWorkspace(j, new AbortController().signal);
    expect(ws.checkout).toBe(await realpathOf(w.clone));
    await w.runner.release(j, ws, undefined);
    expect(existsSync(w.clone)).toBe(true); // the clone outlives the job
  });

  it("finds checkouts by canonical remote identity, only immediate main checkouts", async () => {
    const w = await world();
    const found = await scanCheckouts({ dirs: [join(w.root, "projects")] });
    expect(found.map((c) => c.key)).toEqual(["github.com/acme/app", "github.com/acme/other"]);
    const upper = job({ repo: { ...job().repo, owner: "ACME", name: "App" } });
    expect(await w.runner.resolveCheckout?.(upper)).toBe(await realpathOf(w.owner as string));
    // The runner's own worktrees and clones are never a match.
    const ws = await w.runner.prepareWorkspace(job(), new AbortController().signal);
    const again = await scanCheckouts({
      dirs: [join(w.root, "projects"), join(w.root, "worktrees")],
      exclude: [join(w.root, "worktrees")],
    });
    expect(again).toHaveLength(2);
    await w.runner.release(job(), ws, undefined);
  });

  it("a Stop written before the prompt was sent doesn't end the job", async () => {
    const w = await world({
      onPrompt: (_s, append) => {
        append({ event: "PreToolUse", tool: "Bash", input: '{"command":"ls"}' });
        append({ event: "Stop" });
      },
    });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    // A Stop from before the prompt (Claude finished something on its own as it came up).
    await writeFile(
      ws.statusFile,
      `${JSON.stringify({ event: "Stop", time: Date.now() - 60_000 })}\n`,
    );
    const session = await w.runner.startSession(job(), ws, signal);
    const events = (await drain(w.runner.events(job(), session, signal))).filter(
      (e) => e.type !== "log",
    );
    expect(events.map((e) => e.type)).toEqual([
      "agent.status",
      "tool",
      "agent.status",
      "session.ended",
    ]);
    expect(events[1]).toMatchObject({ type: "tool", name: "Bash" });
    await w.runner.release(job(), ws, session);
  });

  it("an old Stop alone never ends it: the job runs until it is cancelled", async () => {
    const w = await world();
    const controller = new AbortController();
    const ws = await w.runner.prepareWorkspace(job(), controller.signal);
    const session = await w.runner.startSession(job(), ws, controller.signal);
    // Not submitted after the prompt: a Stop from a turn that started before it.
    const s = w.tmux.sessions.get("sf-job_1");
    if (!s) throw new Error("no session");
    await writeFile(
      s.statusFile,
      [
        { event: "SessionStart", time: session.promptSentAt - 10 },
        { event: "UserPromptSubmit", time: session.promptSentAt - 5 },
        { event: "Stop", time: session.promptSentAt - 1 },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")
        .concat("\n"),
    );
    setTimeout(() => controller.abort(new Error("cancelled by a person")), 60);
    const events = await drain(w.runner.events(job(), session, controller.signal));
    expect(events.at(-1)).toEqual({ type: "session.ended", outcome: "cancelled" });
    await w.runner.release(job(), ws, session);
  });

  it("waits on a permission prompt, then fails after the timeout", async () => {
    const w = await world(
      {
        onPrompt: (_s, append) =>
          append({
            event: "Notification",
            type: "permission_prompt",
            message: "Claude needs your permission to use Bash",
          }),
      },
      { waitingInputTimeoutMs: 20 },
    );
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    const events = (await drain(w.runner.events(job(), session, signal))).filter(
      (e) => e.type !== "log",
    );
    expect(events).toEqual([
      { type: "agent.status", status: "working" },
      {
        type: "agent.status",
        status: "waiting_input",
        message: "Claude needs your permission to use Bash",
      },
      expect.objectContaining({ type: "session.ended", outcome: "failed" }),
    ]);
    expect(isWaitingNotification({ type: "idle_prompt" })).toBe(true);
    expect(isWaitingNotification({ type: "auth_success" })).toBe(false);
    expect(isWaitingNotification({ message: "Claude is waiting for your input" })).toBe(true);
    await w.runner.release(job(), ws, session);
  });

  it("gives a job without a repo (flow, spec 70) a plain directory, no git, removed on release", async () => {
    const gitCalls: string[][] = [];
    const w = await world();
    const runner = createLocalRunner({
      ...w.config,
      exec: (cmd, args, opts) => {
        if (cmd === "git") gitCalls.push(args);
        return w.tmux.exec(cmd, args, opts);
      },
    });
    const { repo: _repo, branch: _branch, ...rest } = job();
    const j: Job = { ...rest, stage: "flow" };
    const signal = new AbortController().signal;

    expect(await runner.resolveCheckout?.(j)).toBeNull();
    const ws = await runner.prepareWorkspace(j, signal);
    expect(ws.path).toBe(join(await realpathOf(join(w.root, "worktrees")), "sf-job_1"));
    expect(ws.branch).toBe("");
    expect(ws.baseSha).toBe("");
    expect(existsSync(join(ws.path, ".git"))).toBe(false);
    // Only the harness's own settings in it; dontAsk, writes inside the directory.
    expect(await readdir(ws.path)).toEqual([".claude"]);
    const settings = JSON.parse(await readFile(join(ws.path, SETTINGS_FILE), "utf8"));
    expect(settings.permissions.defaultMode).toBe("dontAsk");
    expect(settings.permissions.allow).toContain(`Write(/${ws.path}/**)`);

    const session = await runner.startSession(j, ws, signal);
    expect(await readFile(join(ws.path, PROMPT_FILE), "utf8")).toBe(j.harness.prompt);
    expect(w.tmux.sessions.get("sf-job_1")?.submitted).toEqual([PROMPT_POINTER]);
    await writeFile(join(ws.path, RESULT_FILE), '{"outcome":"done","summary":"ok"}');
    const s = w.tmux.sessions.get("sf-job_1");
    if (s) s.dead = true;
    const events = await drain(runner.events(j, session, signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });

    w.tmux.sessions.delete("sf-job_1");
    await runner.release(j, ws, session);
    await expect(runner.release(j, ws, session)).resolves.toBeUndefined();
    expect(existsSync(ws.path)).toBe(false);
    expect(existsSync(join(w.runsDir, "job_1"))).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it("connects a flow job's MCP servers (spec 70 M2), keeps their token in the run dir, removes it on release", async () => {
    const token = "Bearer flow-secret-0123456789";
    const w = await world();
    const { repo: _repo, branch: _branch, ...rest } = job();
    const j: Job = {
      ...rest,
      stage: "flow",
      mcpServers: [
        {
          name: "factory",
          url: "https://engine.example.com/flow/mcp",
          headers: { authorization: token },
        },
      ],
    };
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(j, signal);
    const mcpConfig = join(w.runsDir, "job_1", "mcp.json");
    expect(JSON.parse(await readFile(mcpConfig, "utf8"))).toEqual({
      mcpServers: {
        factory: {
          type: "http",
          url: "https://engine.example.com/flow/mcp",
          headers: { authorization: token },
        },
      },
    });
    const settings = JSON.parse(await readFile(join(ws.path, SETTINGS_FILE), "utf8"));
    expect(settings.permissions.allow.filter((r: string) => r.startsWith("mcp__"))).toEqual([
      "mcp__factory__*",
    ]);
    expect(ws.launch.argv.slice(ws.launch.argv.indexOf("--mcp-config"))[1]).toBe(mcpConfig);

    const session = await w.runner.startSession(j, ws, signal);
    await writeFile(join(ws.path, RESULT_FILE), '{"outcome":"done","summary":"ok"}');
    const s = w.tmux.sessions.get("sf-job_1");
    if (s) s.dead = true;
    const events = await drain(w.runner.events(j, session, signal));
    const artifacts = await w.runner.collectArtifacts(j, ws, session);
    // Nothing the host sees or hands back carries the token: only the run dir's MCP config does.
    const seen = JSON.stringify({ ws, session, events, artifacts, sent: [...w.tmux.sessions] });
    expect(seen).not.toContain("flow-secret");
    for (const file of await readdir(join(w.runsDir, "job_1"), { recursive: true })) {
      if (file === "mcp.json") continue;
      const text = await readFile(join(w.runsDir, "job_1", file), "utf8").catch(() => "");
      expect(text, file).not.toContain("flow-secret");
    }

    w.tmux.sessions.delete("sf-job_1");
    await w.runner.release(j, ws, session);
    expect(existsSync(mcpConfig)).toBe(false);
  });

  it("gives a job without MCP servers no MCP config", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const { repo: _repo, branch: _branch, ...rest } = job();
    const flow: Job = { ...rest, stage: "flow" };
    const flowWs = await w.runner.prepareWorkspace(flow, signal);
    expect(flowWs.launch.argv).not.toContain("--mcp-config");
    expect(existsSync(join(w.runsDir, "job_1", "mcp.json"))).toBe(false);
    await w.runner.release(flow, flowWs, undefined);
    const ws = await w.runner.prepareWorkspace(job(), signal);
    expect(ws.launch.argv).not.toContain("--mcp-config");
    const settings = JSON.parse(await readFile(join(ws.path, SETTINGS_FILE), "utf8"));
    expect(settings.permissions.allow.some((r: string) => r.startsWith("mcp__"))).toBe(false);
    await w.runner.release(job(), ws, undefined);
  });

  it("ends when the tmux session goes: completed with a result file, failed without", async () => {
    for (const withResult of [true, false]) {
      const w = await world();
      const signal = new AbortController().signal;
      const ws = await w.runner.prepareWorkspace(job(), signal);
      const session = await w.runner.startSession(job(), ws, signal);
      if (withResult) await writeFile(join(ws.path, RESULT_FILE), "{}");
      const s = w.tmux.sessions.get("sf-job_1");
      if (s) s.dead = true;
      const events = await drain(w.runner.events(job(), session, signal));
      expect(events.at(-1)).toMatchObject({
        type: "session.ended",
        outcome: withResult ? "completed" : "failed",
      });
      w.tmux.sessions.delete("sf-job_1");
      await w.runner.release(job(), ws, session);
    }
  });

  it("ends as timed_out when the host aborts for a timeout", async () => {
    const w = await world();
    const controller = new AbortController();
    const ws = await w.runner.prepareWorkspace(job(), controller.signal);
    const session = await w.runner.startSession(job(), ws, controller.signal);
    setTimeout(() => controller.abort(new Error("session timeout")), 30);
    const events = await drain(w.runner.events(job(), session, controller.signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "timed_out" });
    await w.runner.release(job(), ws, session);
  });

  it("streams scrolled-off terminal lines as logs", async () => {
    const w = await world({
      onPrompt: (s) => {
        s.history.push("line 1", "line 2");
      },
    });
    const controller = new AbortController();
    const ws = await w.runner.prepareWorkspace(job(), controller.signal);
    const session = await w.runner.startSession(job(), ws, controller.signal);
    setTimeout(() => {
      w.tmux.sessions.get("sf-job_1")?.history.push("line 3");
      w.tmux.append("sf-job_1", { event: "Stop" });
    }, 30);
    const logs = (await drain(w.runner.events(job(), session, controller.signal)))
      .filter((e) => e.type === "log")
      .map((e) => (e.type === "log" ? e.text.trim() : ""));
    expect(logs).toEqual(["line 1\nline 2", "line 3"]);
    await w.runner.release(job(), ws, session);
  });

  it("answers Claude's folder trust dialog for the job's worktree once", async () => {
    const w = await world({ trustDialog: true });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    const keys = w.tmux.calls
      .filter((c) => c.includes("send-keys") && !c.includes("-l"))
      .map((c) => c.at(-1));
    expect(keys.slice(0, 2)).toEqual(["Down", "Enter"]);
    expect(w.tmux.sessions.get("sf-job_1")?.submitted).toEqual([PROMPT_POINTER]);
    await w.runner.release(job(), ws, session);
  });

  it("kills the session and fails with harness-config-mismatch when the process isn't as launched", async () => {
    // Incident 2026-11-11 #6: something added the owner's own `--permission-mode auto`.
    const w = await world({}, { readCommand: async () => "claude --permission-mode auto" });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    await expect(w.runner.startSession(job(), ws, signal)).rejects.toThrow(
      /^harness-config-mismatch: .*permission mode auto, expected bypassPermissions/,
    );
    expect(w.tmux.sessions.has("sf-job_1")).toBe(false); // killed
    expect(w.tmux.calls.some((c) => c.includes("-l"))).toBe(false); // no prompt, no work
    expect(existsSync(join(ws.path, PROMPT_FILE))).toBe(false);

    // The same check, for `sf-runner doctor` on a running job.
    const runDir = join(w.runsDir, "job_1");
    const asLaunched = async () => (await readLaunchRecord(runDir))?.argv.join(" ") ?? null;
    expect((await checkRunningHarness(runDir, asLaunched))?.problems).toEqual([]);
    await writeFile(join(ws.path, SETTINGS_FILE), "{}");
    expect((await checkRunningHarness(runDir, asLaunched))?.problems).toEqual([
      `${join(ws.path, SETTINGS_FILE)} changed since it was projected`,
    ]);
    await w.runner.release(job(), ws, undefined);
  });

  it("fails when Claude never comes up, and kills the session", async () => {
    const w = await world({ noSessionStart: true }, { startTimeoutMs: 30 });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    await expect(w.runner.startSession(job(), ws, signal)).rejects.toThrow(/did not start/);
    expect(w.tmux.sessions.size).toBe(0);
    await w.runner.release(job(), ws, undefined);
  });

  it("emits what the agent says from its transcript, in order with the hook's events (ADR 0400)", async () => {
    const w = await world({
      onPrompt: async (s, append) => {
        const transcript = join(s.runDir, "transcript.jsonl");
        const said = (text: string, at: number) =>
          `${JSON.stringify({
            type: "assistant",
            timestamp: new Date(at).toISOString(),
            message: { content: [{ type: "text", text }] },
          })}\n`;
        const tick = () => new Promise((r) => setTimeout(r, 5));
        await tick();
        const t0 = Date.now();
        // An earlier turn of a resumed conversation: not this session's, never sent.
        await writeFile(transcript, said("From last week.", t0 - 3_600_000));
        await writeFile(transcript, said("I'll read the spec first.", t0), { flag: "a" });
        await tick();
        append({ event: "PreToolUse", tool: "Read", input: '{"file_path":"SPEC.md"}', transcript });
        await new Promise((r) => setTimeout(r, 5));
        await writeFile(transcript, said("x".repeat(9_000), Date.now()), { flag: "a" });
        await writeFile(transcript, said("Done: added the line.", Date.now() + 1), { flag: "a" });
        await new Promise((r) => setTimeout(r, 5));
        append({ event: "Stop", transcript });
      },
    });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    const events = (await drain(w.runner.events(job(), session, signal))).filter(
      (e) => e.type !== "log",
    );
    expect(events.map((e) => e.type)).toEqual([
      "agent.status",
      "message",
      "tool",
      "message",
      "message",
      "agent.status",
      "session.ended",
    ]);
    const said = events
      .filter((e) => e.type === "message")
      .map((e) => (e.type === "message" ? e.text : ""));
    expect(said[0]).toBe("I'll read the spec first.");
    expect(said[1]?.length).toBeLessThanOrEqual(8_000);
    expect(said[2]).toBe("Done: added the line.");
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      summary: "Done: added the line.",
    });
    await w.runner.release(job(), ws, session);
  });

  it("reaps sessions and worktrees of jobs the host no longer runs, and doctor sees them first", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const a = await w.runner.prepareWorkspace(job(), signal);
    await w.runner.startSession(job(), a, signal);
    const b = job({ jobId: "job_2", branch: "factory/7-add-a-line-run-2", runNo: 2 });
    const live = await w.runner.prepareWorkspace(b, signal);
    const dirs = {
      worktreesDir: w.config.worktreesDir,
      runsDir: w.runsDir,
      exec: w.tmux.exec,
    };
    const findings = await diagnose({
      ...dirs,
      checkouts: { dirs: [join(w.root, "projects")] },
      live: new Set(["job_2"]),
    });
    expect(findings.map((f) => f.kind).sort()).toEqual(["orphan-session", "orphan-worktree"]);
    expect(await reapOrphans(dirs, new Set(["job_2"]))).toEqual(["job_1"]);
    expect(w.tmux.sessions.has(sessionName("job_1"))).toBe(false);
    expect(existsSync(a.path)).toBe(false);
    expect(git(w.owner as string, "branch", "--list", job().branch)).toBe("");
    expect(existsSync(join(w.runsDir, "job_1"))).toBe(false);
    expect(existsSync(live.path)).toBe(true); // the live job is left alone
    expect(await diagnose({ ...dirs, checkouts: { dirs: [] }, live: new Set(["job_2"]) })).toEqual(
      [],
    );
    await w.runner.release(b, live, undefined);
  });

  it("doctor reports two checkouts of one remote, and leaves them alone", async () => {
    const w = await world();
    const second = join(w.root, "projects", "app-2");
    git(w.root, "clone", "-q", w.bare, second);
    git(second, "remote", "set-url", "origin", "git@github.com:Acme/App.git");
    const findings = await diagnose({
      worktreesDir: w.config.worktreesDir,
      runsDir: w.runsDir,
      exec: w.tmux.exec,
      checkouts: { dirs: [join(w.root, "projects")] },
      live: new Set(),
    });
    expect(findings).toEqual([
      expect.objectContaining({ kind: "duplicate-checkouts", fixable: false }),
    ]);
  });

  it("launches on the host's active account, taken when the workspace is prepared (ADR 0410)", async () => {
    let active = { name: "work", configDir: join(tmpdir(), "sf-acc-work") };
    const usage: [string, string | null][] = [];
    const w = await world(
      { onPrompt: (_s, append) => append({ event: "Stop" }) },
      { account: () => active, onAccountUsage: (a, l) => usage.push([a, l]) },
    );
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    // Switched after the job was prepared: the job keeps its account.
    active = { name: "other", configDir: join(tmpdir(), "sf-acc-other") };
    const script = await readFile(ws.launchScript, "utf8");
    expect(script).toContain(`CLAUDE_CONFIG_DIR=${join(tmpdir(), "sf-acc-work")}`);
    expect(ws.launch).toMatchObject({ account: "work" });
    const session = await w.runner.startSession(job(), ws, signal);
    expect(session).toMatchObject({ account: "work", configDir: join(tmpdir(), "sf-acc-work") });
    const ended = (await drain(w.runner.events(job(), session, signal))).at(-1);
    expect(ended).toMatchObject({ type: "session.ended", outcome: "completed" });
    // A clean run clears the account's usage limit.
    expect(usage).toEqual([["work", null]]);
    await w.runner.release(job(), ws, session);
  });

  it("fails a job that hits its account's usage limit, and says which account (ADR 0410)", async () => {
    const usage: [string, string | null][] = [];
    const w = await world(
      {
        onPrompt: (_s, append) =>
          append({
            event: "StopFailure",
            error: "rate_limit",
            message: "You've hit your usage limit · resets 5pm",
          }),
      },
      {
        account: () => ({ name: "work", configDir: join(tmpdir(), "sf-acc-work") }),
        onAccountUsage: (a, l) => usage.push([a, l]),
      },
    );
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    const events = (await drain(w.runner.events(job(), session, signal))).filter(
      (e) => e.type !== "log",
    );
    expect(events).toContainEqual({
      type: "agent.status",
      status: "error",
      message: `usage limit on Claude account "work": You've hit your usage limit · resets 5pm`,
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      outcome: "failed",
      summary: expect.stringContaining('usage limit on Claude account "work"'),
    });
    expect(usage).toEqual([["work", "You've hit your usage limit · resets 5pm"]]);
    await w.runner.release(job(), ws, session);
  });

  it("reads tmux versions", () => {
    expect(tmuxAtLeast("tmux 3.4")).toBe(true);
    expect(tmuxAtLeast("tmux 3.2a")).toBe(true);
    expect(tmuxAtLeast("tmux 3.1c")).toBe(false);
    expect(tmuxAtLeast("tmux next-3.6")).toBe(true);
    expect(tmuxAtLeast("nope")).toBe(false);
  });
});

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
