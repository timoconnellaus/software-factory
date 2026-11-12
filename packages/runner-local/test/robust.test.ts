// incident #11 (2026-11-12) (spec 43, ADRs 0550, 0551): a tmux that times out or fails is not "the
// session is gone"; a job's processes are stopped from the process table (TERM, then KILL) and
// checked gone before it's released; and the run branches the factory creates are its own to
// delete, whatever their names, never an owner's. Over a scripted tmux and real git; the process
// group tests use real stand-in processes.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readLaunchRecord } from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  isReleaseIncomplete,
  type Job,
} from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyTmux,
  createLocalRunner,
  diagnose,
  type Exec,
  HarnessStillRunning,
  harnessMayBeAlive,
  hostProcs,
  type LocalRunnerConfig,
  type Proc,
  type Procs,
  RUN_BRANCH_MARKERS,
  reapOrphans,
  runsWithSettings,
  stopHarness,
  TmuxGone,
  TmuxUnavailable,
  tmuxCli,
} from "../src/index.ts";
import { type ScriptedTmuxOptions, scriptedTmux, skipTmuxControlTests } from "../src/testing.ts";

const URL = "https://github.com/acme/app.git";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    jobId: "job_1",
    runId: "run_1",
    runNo: 1,
    stage: "build",
    workItem: { id: "wi_1", number: 7, title: "Add a line" },
    repo: { url: URL, owner: "acme", name: "app", baseRef: "factory/7-add-a-line" },
    branch: "factory/7-add-a-line-run-1",
    harness: { id: "claude-code", role: "implement", prompt: "add a line" },
    context: {},
    requires: [],
    limits: { sessionTimeoutMs: 10_000 },
    lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    ...overrides,
  };
}

/**
 * A stand-in process table: one Claude per settings path that is "alive" until it gets the signal
 * it doesn't ignore. Records every signal.
 */
function fakeProcs(options: { diesOn?: NodeJS.Signals | null } = {}) {
  const alive = new Map<string, number>();
  const signals: [number, NodeJS.Signals | 0][] = [];
  let next = 90_000;
  const procs: Procs = {
    async list(): Promise<Proc[]> {
      return [...alive].map(([path, pid]) => ({
        pid,
        ppid: 1,
        pgid: pid,
        command: `claude --settings ${path} --strict-mcp-config`,
      }));
    },
    kill(pid, signal) {
      const entry = [...alive].find(([, p]) => p === Math.abs(pid));
      if (!entry) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (signal === 0) return;
      signals.push([pid, signal]);
      if (signal === (options.diesOn === undefined ? "SIGKILL" : options.diesOn)) {
        alive.delete(entry[0]);
      }
    },
    async ownGroup() {
      return null;
    },
  };
  return {
    procs,
    signals,
    alive,
    start: (settingsPath: string) => alive.set(settingsPath, next++),
  };
}

/** The scripted tmux, which can be made to time out on every call (as under load). */
function flaky(base: Exec) {
  const state = { broken: false, calls: 0 };
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === "tmux" && state.broken) {
      state.calls++;
      return { stdout: "", stderr: "Command failed: tmux", code: 1, timedOut: true };
    }
    return base(cmd, args, opts);
  };
  return { exec, state };
}

async function world(
  tmuxOptions: ScriptedTmuxOptions = {},
  extra: Partial<LocalRunnerConfig> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sf-robust-")));
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
  const owner = join(projects, "app");
  git(root, "clone", "-q", bare, owner);
  git(owner, "remote", "set-url", "origin", URL);
  git(owner, "checkout", "-q", "-b", "owner-work");
  const startSha = git(bare, "rev-parse", "factory/7-add-a-line");
  const tmux = scriptedTmux(tmuxOptions);
  const fl = flaky(tmux.exec);
  const runsDir = join(root, "runs");
  const fake = fakeProcs();
  const config: LocalRunnerConfig = {
    exec: fl.exec,
    checkouts: [projects],
    resolveRepoPath: () => owner,
    worktreesDir: join(root, "worktrees"),
    runsDir,
    startPoint: () => startSha,
    pollMs: 2,
    screenLogMs: 0,
    tmux: { attempts: 2, backoffMs: 1 },
    procs: fake.procs,
    stop: { termGraceMs: 20, killGraceMs: 20, pollMs: 2 },
    readCommand: async () =>
      (await readLaunchRecord(join(runsDir, "job_1")))?.argv.join(" ") ?? null,
    ...extra,
  };
  const runner = createLocalRunner(config);
  return { root, owner, projects, tmux, fl, fake, runner, runsDir, config };
}

async function drain(it: AsyncIterable<AdapterEvent>) {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const settingsOf = (runsDir: string, jobId = "job_1") =>
  join(runsDir, jobId, "claude-settings.json");

/** Waits for a condition instead of a fixed time (the tests run on loaded machines too). */
async function until(what: string, test: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

describe("tmux answers", () => {
  const r = (code: number, stderr = "", timedOut = false) => ({
    stdout: "",
    stderr,
    code,
    ...(timedOut ? { timedOut } : {}),
  });

  it("reads only tmux's own words for 'gone' (3.3–3.6a), never a timeout or another error", () => {
    expect(classifyTmux(r(0))).toBe("ok");
    expect(classifyTmux(r(1, "can't find session: sf-job_1\n"))).toBe("gone");
    expect(classifyTmux(r(1, "can't find window: sf-job_1\n"))).toBe("gone");
    expect(classifyTmux(r(1, "can't find pane: sf-job_1:\n"))).toBe("gone");
    expect(
      classifyTmux(r(1, "no server running on /private/tmp/tmux-501/software-factory\n")),
    ).toBe("gone");
    expect(
      classifyTmux(
        r(1, "error connecting to /tmp/tmux-1000/software-factory (No such file or directory)\n"),
      ),
    ).toBe("gone");
    // Not gone: a timeout (whatever it printed), a connect error under load, a crash, anything else.
    expect(classifyTmux(r(1, "can't find session: x", true))).toBe("error");
    expect(
      classifyTmux(
        r(
          1,
          "error connecting to /tmp/tmux-501/software-factory (Resource temporarily unavailable)",
        ),
      ),
    ).toBe("error");
    expect(classifyTmux(r(1, "server exited unexpectedly"))).toBe("error");
    expect(classifyTmux(r(1, "lost server"))).toBe("error");
    expect(classifyTmux(r(1, "Command failed: tmux -L software-factory kill-session"))).toBe(
      "error",
    );
    expect(classifyTmux(r(137, ""))).toBe("error");
  });

  it("retries failures with backoff, bounded; gone and success answer at once", async () => {
    const answers = [r(1, "x", true), r(1, "lost server"), r(0)];
    const calls: string[][] = [];
    const exec: Exec = async (_c, args) => {
      calls.push(args);
      return { ...(answers.shift() ?? r(0)), stdout: "0:4242:3\n" };
    };
    const t = tmuxCli({ exec, attempts: 4, backoffMs: 1 });
    expect(await t.paneState("sf-job_1")).toEqual({ dead: false, pid: 4242, historySize: 3 });
    expect(calls).toHaveLength(3);

    // Always failing: unavailable after the attempts, never "gone".
    calls.length = 0;
    const down = tmuxCli({ exec: async () => r(1, "x", true), attempts: 3, backoffMs: 1 });
    await expect(down.paneState("sf-job_1")).rejects.toBeInstanceOf(TmuxUnavailable);
    await expect(down.kill("sf-job_1")).rejects.toBeInstanceOf(TmuxUnavailable);
    await expect(down.listSessions()).rejects.toBeInstanceOf(TmuxUnavailable);
    await expect(down.capture("sf-job_1")).rejects.toBeInstanceOf(TmuxUnavailable);

    // Gone answers at once.
    let n = 0;
    const gone = tmuxCli({
      exec: async () => {
        n++;
        return r(1, "can't find session: sf-job_1");
      },
      attempts: 4,
      backoffMs: 1,
    });
    expect(await gone.paneState("sf-job_1")).toBeNull();
    await expect(gone.kill("sf-job_1")).resolves.toBeUndefined();
    await expect(gone.sendKeys("sf-job_1", "Enter")).rejects.toBeInstanceOf(TmuxGone);
    expect(n).toBe(3);
  });

  it("never types the same text twice after a timeout (it may have arrived)", async () => {
    let n = 0;
    const t = tmuxCli({
      exec: async () => {
        n++;
        return r(1, "", true);
      },
      attempts: 4,
      backoffMs: 1,
    });
    await expect(t.sendText("sf-job_1", "hello")).rejects.toBeInstanceOf(TmuxUnavailable);
    expect(n).toBe(1);
  });

  it("starts a session again when it reached a server that was exiting, and never after anything else", async () => {
    // The last session went, and the server was exiting with it when the next start reached it.
    let n = 0;
    const t = tmuxCli({
      exec: async () => (++n === 1 ? r(1, "server exited unexpectedly") : r(0)),
      attempts: 4,
      backoffMs: 1,
    });
    await t.newSession({ name: "a", cwd: "/", command: "true" });
    expect(n).toBe(2);
    // A timeout, or any other failure, may have started it: never retried.
    for (const failure of [r(1, "", true), r(1, "duplicate session: a")]) {
      let calls = 0;
      const once = tmuxCli({
        exec: async () => {
          calls++;
          return failure;
        },
        attempts: 4,
        backoffMs: 1,
      });
      await expect(once.newSession({ name: "a", cwd: "/", command: "true" })).rejects.toThrow();
      expect(calls).toBe(1);
    }
    // A server that keeps exiting: given up after `attempts`, as unavailable.
    let tries = 0;
    const dying = tmuxCli({
      exec: async () => {
        tries++;
        return r(1, "server exited unexpectedly");
      },
      attempts: 3,
      backoffMs: 1,
    });
    await expect(dying.newSession({ name: "a", cwd: "/", command: "true" })).rejects.toBeInstanceOf(
      TmuxUnavailable,
    );
    expect(tries).toBe(3);
  });

  it("every tmux call has a timeout", async () => {
    const seen: (number | undefined)[] = [];
    const t = tmuxCli({
      exec: async (_c, _a, o) => {
        seen.push(o?.timeoutMs);
        return r(0);
      },
      timeoutMs: 1234,
    });
    await t.paneState("a");
    await t.capture("a");
    await t.kill("a");
    await t.listSessions();
    await t.sendKeys("a", "Enter");
    await t.newSession({ name: "a", cwd: "/", command: "true" });
    expect(seen).toEqual([1234, 1234, 1234, 1234, 1234, 1234]);
  });
});

describe("a job while tmux doesn't answer", { timeout: 30_000 }, () => {
  it("keeps running (says so once), and ends on the hook's Stop, completed", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    expect(session.settingsPath).toBe(settingsOf(w.runsDir));
    w.fake.start(settingsOf(w.runsDir));
    w.fl.state.broken = true;
    const events: AdapterEvent[] = [];
    const run = (async () => {
      for await (const e of w.runner.events(job(), session, signal)) events.push(e);
    })();
    // Several polls with tmux timing out, then: still running.
    await until("a few failed polls", () => w.fl.state.calls > 8);
    expect(events.some((e) => e.type === "session.ended")).toBe(false);
    // The capacity doesn't read a silent tmux as "no sessions": it counts its own, takes nothing.
    expect(await w.runner.capacity()).toMatchObject({
      inUse: 1,
      accepting: false,
      paused: { reason: "tmux", pools: ["heavy", "light"] },
    });
    // tmux comes back; the agent finishes.
    w.fl.state.broken = false;
    await until("tmux answers again", () =>
      events.some((e) => e.type === "log" && e.text === "runner: tmux answers again"),
    );
    w.tmux.append("sf-job_1", { event: "Stop" });
    await run;
    const notes = events.filter((e) => e.type === "log" && e.stream === "stderr");
    expect(notes.map((e) => (e as { text: string }).text)).toEqual([
      expect.stringMatching(/^runner: tmux isn't answering \(tmux list-panes timed out/),
      "runner: tmux answers again",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });
    expect((await w.runner.capacity()).accepting).toBe(true);
    await w.runner.release(job(), ws, session);
    // Released: the stand-in Claude was stopped and is gone.
    expect(w.fake.alive.size).toBe(0);
  });

  it("ends only once the process table says Claude is gone", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    w.fake.start(settingsOf(w.runsDir));
    w.fl.state.broken = true;
    const events: AdapterEvent[] = [];
    const run = (async () => {
      for await (const e of w.runner.events(job(), session, signal)) events.push(e);
    })();
    await until("a few failed polls", () => w.fl.state.calls > 8);
    expect(events.some((e) => e.type === "session.ended")).toBe(false);
    w.fake.alive.clear(); // Claude exited
    await run;
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "failed" });
    w.fl.state.broken = false;
    await w.runner.release(job(), ws, session);
  });

  it("a session gone while its Claude still runs waits, then fails; release KILLs what ignores TERM", async () => {
    const w = await world({}, { goneGraceMs: 80 });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    w.fake.start(settingsOf(w.runsDir));
    w.tmux.sessions.delete("sf-job_1"); // tmux: "can't find session"
    const started = Date.now();
    const events = await drain(w.runner.events(job(), session, signal));
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(events.at(-1)).toMatchObject({
      type: "session.ended",
      outcome: "failed",
      summary: expect.stringContaining("still running"),
    });
    await w.runner.release(job(), ws, session);
    expect(w.fake.signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(w.fake.alive.size).toBe(0);
  });

  it("release stops Claude even when kill-session times out, and cleans up", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    w.fake.start(settingsOf(w.runsDir));
    w.fl.state.broken = true;
    await expect(w.runner.release(job(), ws, session)).resolves.toBeUndefined();
    expect(w.fake.alive.size).toBe(0);
    expect(existsSync(ws.path)).toBe(false);
  });

  it("release that can't stop Claude says so (never 'released'); capacity counts it and retries", async () => {
    const w = await world({}, {});
    const stubborn = fakeProcs({ diesOn: null });
    const runner = createLocalRunner({ ...w.config, procs: stubborn.procs });
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job(), signal);
    const session = await runner.startSession(job(), ws, signal);
    stubborn.start(settingsOf(w.runsDir));
    const err = await runner.release(job(), ws, session).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HarnessStillRunning);
    expect(isReleaseIncomplete(err)).toBe(true);
    // The rest was cleaned up anyway.
    expect(existsSync(ws.path)).toBe(false);
    expect((await runner.capacity()).inUse).toBe(1);
    stubborn.alive.clear();
    // Retried in the background: capacity never waits for it.
    await until("the survivor is gone", async () => (await runner.capacity()).inUse === 0);
  });
});

describe("a job's processes on the real process table", { timeout: 30_000 }, () => {
  /** A stand-in Claude: its own group (like a tmux pane), ignores TERM, with a child that does too. */
  async function standIn(settingsPath: string, childFile: string) {
    const script = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      const c = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(childFile)}, String(c.pid));
      setInterval(() => {}, 1000);`;
    const p = spawn(process.execPath, ["-e", script, "--", "--settings", settingsPath], {
      detached: true,
      stdio: "ignore",
    });
    cleanups.push(() => {
      try {
        process.kill(-(p.pid as number), "SIGKILL");
      } catch {
        // Gone.
      }
    });
    const until = Date.now() + 10_000;
    while (!existsSync(childFile) || !(await readFile(childFile, "utf8"))) {
      if (Date.now() > until) throw new Error("the stand-in didn't start");
      await sleep(20);
    }
    return { pid: p.pid as number, child: Number(await readFile(childFile, "utf8")) };
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("TERM, then KILL for a group that ignores TERM, children too; then nothing is left", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-procs-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const settingsPath = join(dir, "job_x", "claude-settings.json");
    const { pid, child } = await standIn(settingsPath, join(dir, "child.pid"));
    const procs = hostProcs();
    expect(await harnessMayBeAlive(procs, settingsPath)).toBe(true);
    const signalled = await stopHarness(procs, settingsPath, {
      termGraceMs: 300,
      killGraceMs: 3_000,
    });
    expect(signalled).toContain(pid);
    expect(await harnessMayBeAlive(procs, settingsPath)).toBe(false);
    const until = Date.now() + 3_000;
    while (alive(child) && Date.now() < until) await sleep(20);
    expect(alive(child)).toBe(false);
    // Nothing running: a no-op.
    expect(await stopHarness(procs, settingsPath)).toEqual([]);
  });

  it("reaping finds a job's Claude left running by its settings path; doctor shows it first", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "sf-reap-")));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const runsDir = join(dir, "runs");
    const dirs = {
      worktreesDir: join(dir, "worktrees"),
      runsDir,
      stop: { termGraceMs: 200, killGraceMs: 3_000 },
      tmux: { socket: `sf-reap-test-${process.pid}`, attempts: 1 },
    };
    const orphan = await standIn(settingsOf(runsDir, "job_9"), join(dir, "a.pid"));
    const live = await standIn(settingsOf(runsDir, "job_8"), join(dir, "b.pid"));
    const findings = await diagnose({ ...dirs, checkouts: { dirs: [] }, live: new Set(["job_8"]) });
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "orphan-process",
        message: expect.stringContaining("job_9"),
      }),
    ]);
    expect(await reapOrphans(dirs, new Set(["job_8"]))).toEqual(["job_9"]);
    expect(alive(orphan.pid)).toBe(false);
    expect(alive(live.pid)).toBe(true); // a running job's is left alone
  });
});

describe("run branches are the factory's own, whatever their names (ADR 0551)", {
  timeout: 30_000,
}, () => {
  const attached = (k = 1) => job({ branch: `timoconnellaus/desktop-terminal-run-${k}`, runNo: k });
  const marker = (owner: string, branch: string) =>
    execFileSync("git", ["for-each-ref", "--format=%(refname)", `${RUN_BRANCH_MARKERS}${branch}`], {
      cwd: owner,
      encoding: "utf8",
    }).trim();

  it("an attached PR's run branch is marked, and deleted on release", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(attached(), signal);
    expect(ws.createdBranch).toBe(true);
    expect(marker(w.owner, ws.branch)).toBe(`${RUN_BRANCH_MARKERS}${ws.branch}`);
    await w.runner.release(attached(), ws, undefined);
    expect(git(w.owner, "branch", "--list", ws.branch)).toBe("");
    expect(marker(w.owner, ws.branch)).toBe("");
  });

  it("a re-run after a crash takes over the stale branch the crashed run left", async () => {
    const w = await world();
    // What a crash (or a re-attached PR's -run-1) left: the branch, no worktree.
    git(w.owner, "branch", attached().branch, "origin/factory/7-add-a-line");
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(attached(), signal);
    expect(git(ws.path, "branch", "--show-current")).toBe(attached().branch);
    await w.runner.release(attached(), ws, undefined);
    expect(git(w.owner, "branch", "--list", attached().branch)).toBe("");
  });

  it("a branch checked out in another worktree is left alone, and the job refuses it", async () => {
    const w = await world();
    const elsewhere = join(w.root, "owners-own-worktree");
    git(
      w.owner,
      "worktree",
      "add",
      "-q",
      "-b",
      attached().branch,
      elsewhere,
      "origin/factory/7-add-a-line",
    );
    await expect(
      w.runner.prepareWorkspace(attached(), new AbortController().signal),
    ).rejects.toThrow(/checked out at/);
    expect(git(elsewhere, "branch", "--show-current")).toBe(attached().branch);
  });

  it("reap and doctor sweep marked branches crashed jobs left, never an owner's", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(attached(2), signal);
    // The crash: the worktree went, the branch and its marker stayed.
    git(w.owner, "worktree", "remove", "--force", ws.path);
    // The owner's own branch with a run-like name, unmarked.
    git(w.owner, "branch", "mine-run-1", "origin/factory/7-add-a-line");
    const dirs = {
      worktreesDir: w.config.worktreesDir,
      runsDir: w.runsDir,
      exec: w.fl.exec,
      procs: w.fake.procs,
      checkouts: { dirs: [w.projects] },
    };
    const findings = await diagnose({ ...dirs, live: new Set() });
    expect(findings.filter((f) => f.kind === "orphan-branch")).toEqual([
      expect.objectContaining({ message: expect.stringContaining(attached(2).branch) }),
    ]);
    await reapOrphans(dirs, new Set());
    expect(git(w.owner, "branch", "--list", attached(2).branch)).toBe("");
    expect(git(w.owner, "branch", "--list", "mine-run-1")).toBe("mine-run-1");
    expect(git(w.owner, "branch", "--list", "owner-work")).toContain("owner-work");
    expect((await diagnose({ ...dirs, live: new Set() })).map((f) => f.kind)).not.toContain(
      "orphan-branch",
    );
  });
});

describe("a steer typed mid-turn (tmux)", { timeout: 30_000 }, () => {
  it("doesn't end at the current turn's Stop: it ends at the steered turn's", async () => {
    const w = await world({ queueSteers: true }, { turnGraceMs: 10_000 });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    const events: AdapterEvent[] = [];
    const run = (async () => {
      for await (const e of w.runner.events(job(), session, signal)) events.push(e);
    })();
    await w.runner.steer?.(session, "also update the changelog");
    w.tmux.append("sf-job_1", { event: "Stop" }); // the first turn's Stop
    await until("the Stop is read", () =>
      events.some((e) => e.type === "agent.status" && e.status === "idle"),
    );
    expect(events.some((e) => e.type === "session.ended")).toBe(false);
    // Claude takes the queued steer as its next turn, then stops.
    w.tmux.append("sf-job_1", { event: "UserPromptSubmit" });
    w.tmux.append("sf-job_1", { event: "Stop" });
    await run;
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });
    await w.runner.release(job(), ws, session);
  });

  it("a steered turn that shows work but no UserPromptSubmit (a late hook) isn't cut off at the grace", async () => {
    const w = await world({ queueSteers: true }, { turnGraceMs: 50 });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    const events: AdapterEvent[] = [];
    const run = (async () => {
      for await (const e of w.runner.events(job(), session, signal)) events.push(e);
    })();
    await w.runner.steer?.(session, "also update the changelog");
    w.tmux.append("sf-job_1", { event: "Stop" });
    await until("the Stop is read", () =>
      events.some((e) => e.type === "agent.status" && e.status === "idle"),
    );
    // The steered turn works; its UserPromptSubmit never comes.
    w.tmux.append("sf-job_1", { event: "PreToolUse", tool: "Edit" });
    await until("the tool is read", () => events.some((e) => e.type === "tool"));
    // Well past the grace period: still running.
    const past = Date.now() + 200;
    await until("past the grace", () => Date.now() > past);
    expect(events.some((e) => e.type === "session.ended")).toBe(false);
    w.tmux.append("sf-job_1", { event: "Stop" });
    await run;
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });
    await w.runner.release(job(), ws, session);
  });

  it("ends after the grace period when Claude folded the steer into the turn that stopped", async () => {
    const w = await world({ queueSteers: true }, { turnGraceMs: 60 });
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    await w.runner.steer?.(session, "and the docs");
    w.tmux.append("sf-job_1", { event: "Stop" });
    const started = Date.now();
    const events = await drain(w.runner.events(job(), session, signal));
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });
    await w.runner.release(job(), ws, session);
  });
});

describe("whose processes are the job's (review of #87)", () => {
  const path = "/runs/job_1/claude-settings.json";
  /** A table of processes; `kill` throws what `errors` says per pid, else succeeds (and kills). */
  function table(
    list: Proc[],
    options: { uid?: number; eperm?: number[]; cwds?: Record<number, string> } = {},
  ) {
    const alive = new Set(list.map((p) => p.pid));
    const signalled: [number, NodeJS.Signals | 0][] = [];
    const procs: Procs = {
      list: async () => list.filter((p) => alive.has(p.pid)),
      kill(pid, signal) {
        const target = Math.abs(pid);
        if (options.eperm?.includes(target)) {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
        const members =
          pid < 0 ? list.filter((p) => p.pgid === target) : list.filter((p) => p.pid === target);
        if (!members.some((p) => alive.has(p.pid))) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        if (signal === 0) return;
        signalled.push([pid, signal]);
        for (const m of members) alive.delete(m.pid);
      },
      ownGroup: async () => 1,
      uid: () => options.uid ?? 501,
      cwds: async (pids) =>
        new Map(pids.filter((p) => options.cwds?.[p]).map((p) => [p, options.cwds?.[p] as string])),
    };
    return { procs, signalled, alive };
  }
  const stop = { termGraceMs: 10, killGraceMs: 10, pollMs: 1 };

  it("only `--settings <path>`, only the runner's user: never the owner's less, tail or grep on it", async () => {
    expect(runsWithSettings(`claude --settings ${path} --strict-mcp-config`, path)).toBe(true);
    expect(runsWithSettings(`claude --settings=${path}`, path)).toBe(true);
    expect(runsWithSettings(`less ${path}`, path)).toBe(false);
    expect(runsWithSettings(`grep -r settings ${path}`, path)).toBe(false);
    expect(runsWithSettings(`claude --settings ${path}.bak`, path)).toBe(false);
    const t = table([
      { pid: 10, ppid: 1, pgid: 10, uid: 501, command: `claude --settings ${path}` },
      { pid: 20, ppid: 1, pgid: 20, uid: 501, command: `less ${path}` },
      { pid: 30, ppid: 1, pgid: 30, uid: 0, command: `claude --settings ${path}` },
    ]);
    expect(await stopHarness(t.procs, path, stop)).toEqual([10]);
    expect(t.signalled.map(([p]) => p)).toEqual([-10]);
    expect(t.alive.has(20)).toBe(true);
    expect(t.alive.has(30)).toBe(true);
  });

  it("a process it may not signal (EPERM) isn't the job's and doesn't pin it as a survivor", async () => {
    const t = table(
      [
        { pid: 10, ppid: 1, pgid: 10, command: `claude --settings ${path}` },
        { pid: 11, ppid: 10, pgid: 99, command: "setuid-helper" },
      ],
      { eperm: [11] },
    );
    await expect(stopHarness(t.procs, path, stop)).resolves.toContain(10);
  });

  it("stops a dev server that left the group and was re-parented to init, by its cwd in the worktree", async () => {
    const t = table(
      [
        { pid: 10, ppid: 1, pgid: 10, command: `claude --settings ${path}` },
        { pid: 40, ppid: 1, pgid: 40, command: "node dev-server.js" },
        { pid: 41, ppid: 40, pgid: 40, command: "esbuild --watch" },
        { pid: 50, ppid: 1, pgid: 50, command: "node other.js" },
        { pid: 60, ppid: 900, pgid: 60, command: "zsh" },
      ],
      { cwds: { 40: "/wt/sf-job_1/app", 50: "/elsewhere", 60: "/wt/sf-job_1" } },
    );
    const signalled = await stopHarness(t.procs, path, { ...stop, worktree: "/wt/sf-job_1" });
    expect(signalled.sort()).toEqual([10, 40, 41]);
    expect(t.alive.has(50)).toBe(true);
    // The owner's shell in the worktree has a live parent: left alone.
    expect(t.alive.has(60)).toBe(true);
  });
});

describe("leftover sessions don't eat capacity (review of #87)", { timeout: 30_000 }, () => {
  it("a dead pane doesn't count, nor an abandoned session whose Claude is gone, and it is killed later", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const ws = await w.runner.prepareWorkspace(job(), signal);
    const session = await w.runner.startSession(job(), ws, signal);
    expect((await w.runner.capacity()).inUse).toBe(1);
    const s = w.tmux.sessions.get("sf-job_1");
    if (s) s.dead = true;
    expect((await w.runner.capacity()).inUse).toBe(0);
    if (s) s.dead = false;
    // Release while kill-session times out: the session stays on the server.
    w.fl.state.broken = true;
    await w.runner.release(job(), ws, session);
    w.fl.state.broken = false;
    expect(w.tmux.sessions.has("sf-job_1")).toBe(true);
    // The background clean-up kills it; until then, with no Claude, it doesn't count.
    await until("the abandoned session is killed", async () => {
      await w.runner.capacity();
      return !w.tmux.sessions.has("sf-job_1");
    });
    expect((await w.runner.capacity()).inUse).toBe(0);
  });
});

describe("the marker never costs the owner commits (review of #87)", { timeout: 30_000 }, () => {
  const branch = "timoconnellaus/desktop-terminal-run-2";
  it("a marked branch the owner committed on is kept by the sweep, moved aside by a new run", async () => {
    const w = await world();
    const signal = new AbortController().signal;
    const j = job({ branch, runNo: 2 });
    const ws = await w.runner.prepareWorkspace(j, signal);
    // The crash: the worktree went, the branch and its marker stayed.
    git(w.owner, "worktree", "remove", "--force", ws.path);
    // The owner checks it out, commits a fix and switches away.
    git(w.owner, "checkout", "-q", branch);
    await writeFile(join(w.owner, "FIX.md"), "mine\n");
    git(w.owner, "add", "FIX.md");
    git(w.owner, "-c", "user.name=o", "-c", "user.email=o@x.invalid", "commit", "-qm", "my fix");
    const mine = git(w.owner, "rev-parse", "HEAD");
    git(w.owner, "checkout", "-q", "owner-work");
    const dirs = {
      worktreesDir: w.config.worktreesDir,
      runsDir: w.runsDir,
      exec: w.fl.exec,
      procs: w.fake.procs,
      checkouts: { dirs: [w.projects] },
    };
    const findings = (await diagnose({ ...dirs, live: new Set() })).filter(
      (f) => f.kind === "orphan-branch",
    );
    expect(findings).toEqual([expect.objectContaining({ fixable: false })]);
    await reapOrphans(dirs, new Set());
    expect(git(w.owner, "rev-parse", branch)).toBe(mine);
    // A re-run of that job takes the name, and the owner's commit is kept under another one.
    const again = await w.runner.prepareWorkspace(j, signal);
    const kept = git(w.owner, "branch", "--list", `${branch}-kept-*`).replace(/^[*+ ]+/, "");
    expect(git(w.owner, "rev-parse", kept)).toBe(mine);
    await w.runner.release(j, again, undefined);
  });
});

describe("the control-mode tests' guard", () => {
  it("skips inside a factory job, unless asked", () => {
    expect(skipTmuxControlTests({})).toBe(false);
    expect(skipTmuxControlTests({ SOFTWARE_FACTORY_RUN: "1" })).toBe(true);
    expect(skipTmuxControlTests({ SOFTWARE_FACTORY_RUN: "1", SF_TMUX_CONTROL_TESTS: "1" })).toBe(
      false,
    );
  });
});
