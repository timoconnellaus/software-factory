// ADR 0260 (amended by ADR 0380) over real git and a scripted tmux: the real runner-local adapter
// and the host's git. A job runs as a worktree of the owner's own checkout, found under the
// `checkouts` dirs by canonical remote identity, and never changes that checkout; with none, the
// host's clone, made once and kept. Incident 2026-11-11 (#5) was a second registration per job.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROMPT_POINTER, readLaunchRecord } from "@software-factory/harness-claude";
import { type Job, RESULT_FILE } from "@software-factory/runner-contract";
import { createLocalRunner, type Exec, type LocalRunnerConfig } from "@software-factory/runner-local";
import {
  fakeStreamClaude,
  type ScriptedTmuxOptions,
  scriptedTmux,
} from "@software-factory/runner-local/testing";
import { afterEach, describe, expect, it } from "vitest";
import { expandHome, legacyCheckoutDirs, migrateCheckouts } from "../src/checkouts.ts";
import { configSchema } from "../src/config.ts";
import { FETCH_NAMESPACE } from "../src/git.ts";
import { runJob } from "../src/job.ts";
import { controlPlane, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const TOKEN = "ghs_SECRET_never_on_disk_0123456789";
const URL = "https://github.com/acme/app.git";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** "GitHub" (a bare repo), the owner's own checkout of it, the runner's state dir, a fake tmux. */
async function world(
  options: {
    ownerCheckout?: boolean;
    tmux?: ScriptedTmuxOptions;
    local?: Partial<LocalRunnerConfig>;
  } = {},
) {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  const reposDir = join(repo.root, "repos"); // the host's clone dir (scratchRepo's hostGit uses it)
  const projects = join(repo.root, "projects");
  let owner: string | null = null;
  if (options.ownerCheckout ?? true) {
    owner = join(projects, "app");
    git(repo.root, "clone", "-q", repo.bare, owner);
    git(owner, "remote", "set-url", "origin", URL); // what the owner's checkout really points at
    await writeFile(join(owner, ".env"), "OWNER_SECRET=1\n");
    git(owner, "checkout", "-q", "-b", "owner-work");
    await writeFile(join(owner, "WIP.txt"), "uncommitted\n");
    owner = realpathSync(owner);
  }
  const tmux = scriptedTmux(options.tmux);
  const runsDir = join(repo.root, "runs");
  const adapter = createLocalRunner({
    exec: tmux.exec,
    checkouts: [projects],
    resolveRepoPath: (j) => repo.host.clonePath(j),
    ownReposDir: reposDir,
    worktreesDir: join(repo.root, "worktrees"),
    runsDir,
    startPoint: (j, path) => repo.host.startPoint(j, path),
    pollMs: 2,
    // `ps` shows the launch record's argv: the harness started as set.
    readCommand: async () => {
      const [jobDir] = await readdir(runsDir);
      return (await readLaunchRecord(join(runsDir, jobDir ?? "")))?.argv.join(" ") ?? null;
    },
    ...options.local,
  });
  return { ...repo, reposDir, tmux, owner, adapter };
}

type World = Awaited<ReturnType<typeof world>>;

/** One job's workspace lifecycle, as runJob drives it: resolve → fetch → prepare → release. */
async function cycle(w: World, j: Job) {
  const existing = await w.adapter.resolveCheckout?.(j);
  const checkout = await w.host.ensureRepo(j, TOKEN, existing ?? null);
  const ws = await w.adapter.prepareWorkspace(j, new AbortController().signal);
  await w.adapter.release(j, ws, undefined);
  return { existing, checkout, ws };
}

/** Every file under a .git dir except objects, for "the token never lands on disk". */
async function gitFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && !path.includes(`${join(dir, "objects")}`)) out.push(path);
  }
  return out;
}

const ownerState = (owner: string) => ({
  head: git(owner, "rev-parse", "HEAD"),
  branch: git(owner, "branch", "--show-current"),
  branches: git(owner, "branch", "--list"),
  status: git(owner, "status", "--porcelain"),
  remote: git(owner, "remote", "-v"),
  worktrees: git(owner, "worktree", "list"),
  config: execFileSync("cat", [join(owner, ".git", "config")], { encoding: "utf8" }),
  fetchHead: existsSync(join(owner, ".git", "FETCH_HEAD")),
});

describe("workspace resolution (ADR 0260, amended)", { timeout: 30_000 }, () => {
  it("runs jobs as worktrees of the owner's checkout: no clone, no churn, the checkout unchanged", async () => {
    const w = await world();
    const owner = w.owner as string;
    const before = ownerState(owner);

    for (let n = 1; n <= 3; n++) {
      const j = job({ jobId: `job_${n}`, runNo: n, branch: `factory/7-add-a-line-run-${n}` });
      const { existing, checkout, ws } = await cycle(w, j);
      expect(existing).toBe(owner);
      expect(checkout).toBe(owner);
      expect(ws.path.startsWith(owner)).toBe(false); // its own worktree, not the owner's checkout
      expect(ws.baseSha).toBe(git(w.bare, "rev-parse", "factory/7-add-a-line"));
      // Released: the worktree and run branch are gone.
      expect(existsSync(ws.path)).toBe(false);
      expect(git(owner, "branch", "--list", j.branch)).toBe("");
    }
    expect(existsSync(w.reposDir)).toBe(false); // no clone made

    // The owner's checkout: same branch, head, uncommitted work, branches, worktrees, remotes,
    // config; no FETCH_HEAD.
    expect(ownerState(owner)).toEqual(before);
    // The item branch landed in the host's own namespace only.
    expect(git(owner, "rev-parse", `${FETCH_NAMESPACE}/factory/7-add-a-line`)).toBe(
      git(w.bare, "rev-parse", "factory/7-add-a-line"),
    );
    // The job token never lands in the checkout's git dir.
    for (const file of await gitFiles(join(owner, ".git"))) {
      expect(await readFile(file, "utf8").catch(() => ""), file).not.toContain(TOKEN);
    }
  });

  it("with no checkout for the remote: clones once and keeps it", async () => {
    const w = await world({ ownerCheckout: false });
    for (let n = 1; n <= 3; n++) {
      const j = job({ jobId: `job_${n}`, runNo: n, branch: `factory/7-add-a-line-run-${n}` });
      const { existing, checkout, ws } = await cycle(w, j);
      expect(existing).toBeNull(); // the host's clone is never a "checkout" match
      expect(checkout).toBe(w.host.clonePath(j));
      expect(ws.path.startsWith(w.reposDir)).toBe(false);
      expect(existsSync(w.host.clonePath(j))).toBe(true); // kept after release
    }
    const config = await readFile(join(w.host.clonePath(job()), ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
  });

  it("runJob end to end: builds in the owner's checkout and pushes only the run branch", async () => {
    const w = await world({
      tmux: {
        onPrompt: (s, append) => {
          execFileSync("sh", ["-c", "echo hello >> README.md"], { cwd: s.cwd });
          git(s.cwd, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "add");
          execFileSync("sh", ["-c", `echo '{"notes":"ok"}' > ${RESULT_FILE}`], { cwd: s.cwd });
          append({ event: "PreToolUse", tool: "Bash", input: '{"command":"git commit"}' });
          append({ event: "Stop" });
        },
      },
    });
    const owner = w.owner as string;
    const before = ownerState(owner);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job();
    cloud.claims.set("c", j);
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.error).toBeUndefined();
    expect(report.outcome).toBe("completed");
    expect(report.headSha).toBe(git(w.bare, "rev-parse", j.branch));
    expect(ownerState(owner)).toEqual(before);
    expect(git(owner, "branch", "--list", j.branch)).toBe("");
    const events = cloud.events.get(j.jobId) ?? [];
    expect(events.some((e) => e.type === "tool" && e.name === "Bash")).toBe(true);
    const started = events.find((e) => e.type === "session.started");
    expect(started).toMatchObject({
      takeover: { hint: `tmux -L software-factory attach -t sf-${j.jobId}` },
    });
    expect(w.tmux.sessions.size).toBe(0); // released
    await rm(join(w.root, "runs"), { recursive: true, force: true });
  });
});

describe("a stream-json session through runJob (spec 37, ADR 0450)", { timeout: 30_000 }, () => {
  async function streamWorld(fake: { firstTurnMs?: number } = {}) {
    const bin = join(await realpathOf(tmpdir()), `sf-fake-claude-${process.pid}-${Date.now()}`);
    await mkdir(bin, { recursive: true });
    cleanups.push(() => rm(bin, { recursive: true, force: true }));
    const stdinLog = join(bin, "stdin.jsonl");
    const claudeBin = join(bin, "claude.mjs");
    await writeFile(
      claudeBin,
      fakeStreamClaude({ stdinLog, commit: true, writeResult: true, ...fake }),
      { mode: 0o755 },
    );
    const w = await world({
      local: { session: "stream-json", claudeBin, turnGraceMs: 200, waitingInputTimeoutMs: 20_000 },
    });
    return { ...w, stdinLog };
  }

  it("builds end to end: the prompt as JSON, events from the stream, the run branch pushed", async () => {
    const w = await streamWorld();
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job();
    cloud.claims.set("c", j);
    expect((await w.adapter.manifest()).capabilities).toContain("chat");
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.error).toBeUndefined();
    expect(report.outcome).toBe("completed");
    expect(report.headSha).toBe(git(w.bare, "rev-parse", j.branch));
    const events = cloud.events.get(j.jobId) ?? [];
    expect(events.find((e) => e.type === "session.started")).toMatchObject({ mode: "stream" });
    const types = events.map((e) => e.type);
    for (const t of ["message", "tool", "tool.result", "turn"]) expect(types).toContain(t);
    const first = JSON.parse((await readFile(w.stdinLog, "utf8")).split("\n")[0] ?? "{}");
    expect(first).toMatchObject({ type: "user", message: { content: PROMPT_POINTER } });
    expect(w.tmux.calls.some((c) => c.includes("new-session"))).toBe(false);
  });

  it("takes the session over when the dashboard asks, and hands back when the terminal session ends", async () => {
    const w = await streamWorld({ firstTurnMs: 10_000 });
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job();
    cloud.claims.set("c", j);
    const running = runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    // Once the session is up, the owner asks for a takeover (run.takeover's row).
    const seen = async (type: string) => {
      for (let i = 0; i < 500; i++) {
        const found = (cloud.events.get(j.jobId) ?? []).find((e) => e.type === type);
        if (found) return found;
        await sleep(20);
      }
      throw new Error(`no ${type} event`);
    };
    await seen("tool");
    cloud.steers.set(j.jobId, [
      { id: "st_t", text: "", at: new Date().toISOString(), kind: "takeover" },
    ]);
    const handed = (await seen("takeover")) as { hint: string; sessionId: string };
    expect(handed.hint).toContain(`--resume ${handed.sessionId}`);
    // The person resumes it in the worktree, commits, and quits: the projected status hook
    // reports the session.
    const worktree = /^cd (\S+) && /.exec(handed.hint)?.[1] as string;
    expect(existsSync(worktree)).toBe(true);
    await appendFile(join(worktree, "README.md"), "by hand\n");
    git(worktree, "-c", "user.name=p", "-c", "user.email=p@x.invalid", "commit", "-qam", "by hand");
    const statusFile = join(w.root, "runs", j.jobId, "status.jsonl");
    await appendFile(statusFile, `${JSON.stringify({ event: "SessionStart", time: Date.now() })}\n`);
    await appendFile(statusFile, `${JSON.stringify({ event: "SessionEnd", time: Date.now() })}\n`);
    const report = await running;
    expect(report.outcome).toBe("completed");
    expect(report.handedBack).toBe(true);
    expect(report.headSha).toBe(git(w.bare, "rev-parse", j.branch));
  });
});

async function realpathOf(path: string) {
  return realpathSync(path);
}

describe("checkouts in runner.json", () => {
  const orcaList =
    (paths: string[]): Exec =>
    async (cmd) =>
      cmd === "orca"
        ? {
            stdout: JSON.stringify({
              ok: true,
              result: { repos: paths.map((path) => ({ path })) },
            }),
            stderr: "",
            code: 0,
          }
        : { stdout: "", stderr: "not found", code: 127 };
  const base = configSchema.parse({ runnerId: "r_abc123", key: "k".repeat(32) });

  it("fills them in once from the desktop app's repos (their parent dirs), then leaves them alone", async () => {
    const exec = orcaList([
      "/Users/x/orca/projects/app",
      "/Users/x/orca/projects/other",
      "/Users/x/code/site",
      "/Users/x/.local/state/software-factory/runner/repos/acme/app",
    ]);
    const exclude = ["/Users/x/.local/state/software-factory/runner/repos"];
    const first = await migrateCheckouts(base, exec, exclude);
    expect(first.chosen).toEqual(["/Users/x/orca/projects", "/Users/x/code"]);
    expect(first.config.checkouts).toEqual(["/Users/x/orca/projects", "/Users/x/code"]);
    // Already set (even to nothing): no change.
    const again = await migrateCheckouts({ ...base, checkouts: [] }, exec, exclude);
    expect(again).toEqual({ config: { ...base, checkouts: [] }, chosen: null });
  });

  it("is empty without the app", async () => {
    const none: Exec = async () => ({ stdout: "", stderr: "command not found", code: 127 });
    expect(await legacyCheckoutDirs(none, [])).toEqual([]);
    expect((await migrateCheckouts(base, none, [])).config.checkouts).toEqual([]);
  });

  it("expands ~ in configured dirs", () => {
    expect(expandHome("~/code", "/Users/x")).toBe("/Users/x/code");
    expect(expandHome("/abs", "/Users/x")).toBe("/abs");
  });

  it("older configs with orcaBin still load", () => {
    const parsed = configSchema.parse({
      runnerId: "r_abc123",
      key: "k".repeat(32),
      orcaBin: "orca",
    });
    expect(parsed).not.toHaveProperty("orcaBin");
  });
});
