// Spec 08 (ADR 0360): the runner updates itself to the deployed commit, only when idle, refuses
// rather than guesses, and the `sh` wrapper rolls back an update that never confirmed.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RunnerVersion } from "@software-factory/runner-contract";
import { nodeExec } from "@software-factory/runner-local";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerHost } from "../src/host.ts";
import {
  createSelfUpdater,
  readRolledBack,
  readUpdateRecord,
  readVersionStatus,
  type SelfUpdaterOptions,
} from "../src/self-update.ts";
import { controlPlane, fakeAdapter, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sf-runner-service");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", file);
  return git(cwd, "rev-parse", "HEAD");
};

/**
 * The software-factory repo as a runner sees it: `origin.git` (GitHub), `seed` (where merges land),
 * and `runner`, the runner's own checkout on main at A. origin/main has moved on to B and C.
 */
async function world() {
  const root = await mkdtemp(join(tmpdir(), "sf-update-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  mkdirSync(join(seed, "local", "runner-host", "bin"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  copyFileSync(WRAPPER, join(seed, "local", "runner-host", "bin", "sf-runner-service"));
  writeFileSync(join(seed, ".gitignore"), "node_modules\n");
  const a = commit(seed, "a.txt", "a");
  const origin = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", seed, origin);
  git(seed, "remote", "add", "origin", origin);
  const runner = join(root, "runner");
  git(root, "clone", "-q", origin, runner);
  const b = commit(seed, "b.txt", "b");
  const c = commit(seed, "c.txt", "c");
  git(seed, "push", "-q", "origin", "main");
  const stateDir = join(root, "state");
  const installs: string[] = [];
  const logs: string[] = [];
  const updater = (overrides: Partial<SelfUpdaterOptions> = {}) =>
    createSelfUpdater({
      repo: runner,
      stateDir,
      autoUpdate: true,
      canRestart: true,
      exec: nodeExec,
      installDeps: async (repo) => {
        installs.push(repo);
      },
      log: (m) => logs.push(m),
      fetchEveryMs: 0,
      ...overrides,
    });
  return { root, seed, origin, runner, stateDir, a, b, c, installs, logs, updater };
}

/** The host's git for jobs (no job runs in these tests). */
async function hostGit() {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  return repo.host;
}

const head = (repo: string) => git(repo, "rev-parse", "HEAD");
const versions = (cloud: ReturnType<typeof fakeCloud>) =>
  cloud.heartbeats.map((h) => h.version).filter((v): v is RunnerVersion => !!v);

async function until(what: string, ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("self-update: behind and idle (criterion 2)", () => {
  it("fast-forwards to exactly the desired commit, reinstalls, records it and restarts; the next start confirms", async () => {
    const w = await world();
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    cloud.desiredVersion = w.b; // deployed B, though origin/main is already at C
    const adapter = fakeAdapter(
      () => w.runner,
      async () => [],
    );
    let updated = 0;
    const host = new RunnerHost({
      adapter,
      cp,
      git: await hostGit(),
      maxConcurrent: 1,
      heartbeatMs: 30,
      log: () => {},
      selfUpdate: await w.updater(),
      onUpdated: () => updated++,
    });
    await host.start();
    await until("the restart", () => updated === 1);
    expect(head(w.runner)).toBe(w.b);
    expect(git(w.runner, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(w.installs).toEqual([w.runner]);
    expect(await readUpdateRecord(w.stateDir)).toMatchObject({
      status: "pending",
      from: w.a,
      to: w.b,
      mode: "branch",
      starts: 0,
    });
    // The heartbeat before it reported the old code; nothing was claimed.
    expect(versions(cloud)[0]).toMatchObject({ sha: w.a, autoUpdate: true });
    await host.stop();
    expect(updated).toBe(1);

    // The new code starts: its first heartbeat confirms the update and it reports current.
    const cloud2 = fakeCloud();
    cloud2.desiredVersion = w.b;
    const host2 = new RunnerHost({
      adapter,
      cp: await controlPlane(cloud2),
      git: await hostGit(),
      maxConcurrent: 1,
      heartbeatMs: 30,
      log: () => {},
      selfUpdate: await w.updater(),
      onUpdated: () => updated++,
    });
    await host2.start();
    await until("two heartbeats", () => cloud2.heartbeats.length >= 2);
    await host2.stop();
    expect((await readUpdateRecord(w.stateDir))?.status).toBe("confirmed");
    expect(versions(cloud2)[0]?.sha).toBe(w.b);
    expect(versions(cloud2)[0]?.update.state).toBe("current");
    expect(versions(cloud2)[1]?.update).toEqual({ state: "current", target: w.b, reason: null });
    expect(updated).toBe(1);
    expect(await readVersionStatus(w.stateDir)).toMatchObject({
      sha: w.b,
      desired: w.b,
      state: "current",
    });
  });

  it("a detached checkout moves detached", async () => {
    const w = await world();
    git(w.runner, "checkout", "-q", "--detach");
    const u = await w.updater();
    expect(await u.consider(w.c, true)).toBe("restart");
    expect(head(w.runner)).toBe(w.c);
    expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: w.runner }).status).not.toBe(0);
    expect((await readUpdateRecord(w.stateDir))?.mode).toBe("detached");
  });

  it("a failed install moves back and carries on, without restarting", async () => {
    const w = await world();
    const u = await w.updater({
      installDeps: async (repo) => {
        w.installs.push(repo);
        if (head(repo) === w.c) throw new Error("ERR_PNPM_OUTDATED_LOCKFILE");
      },
    });
    expect(await u.consider(w.c, true)).toBe("claim");
    expect(head(w.runner)).toBe(w.a);
    expect(w.installs).toHaveLength(2); // the new commit's, then the old one's again
    expect(u.report().update).toMatchObject({ state: "blocked", target: w.c });
    expect(u.report().update.reason).toMatch(/ERR_PNPM_OUTDATED_LOCKFILE/);
    expect((await readUpdateRecord(w.stateDir))?.status).toBe("failed");
    // Not retried on the next turn.
    expect(await u.consider(w.c, true)).toBe("claim");
    expect(w.installs).toHaveLength(2);
  });
});

describe("self-update: behind but busy (criterion 3)", () => {
  it("claims nothing new, reports waiting, and updates once its last job ends, cancelling none", async () => {
    const w = await world();
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    let finish!: () => void;
    const finished = new Promise<void>((r) => {
      finish = r;
    });
    let aborted = false;
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt, _j, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await finished;
        writeFileSync(join(wt, "README.md"), "# scratch\nbusy\n");
        git(wt, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "work");
        return [{ type: "session.ended" as const, outcome: "completed" as const, summary: "ok" }];
      },
    );
    const first = job();
    cloud.queue.push(first);
    let updated = 0;
    const host = new RunnerHost({
      adapter,
      cp,
      git: repo.host,
      maxConcurrent: 2,
      heartbeatMs: 30,
      log: () => {},
      selfUpdate: await w.updater(),
      onUpdated: () => updated++,
    });
    await host.start();
    expect(host.activeJobs).toEqual([first.jobId]);

    // A deploy lands while the job runs, and more work is queued.
    cloud.desiredVersion = w.c;
    const second = job();
    cloud.queue.push(second);
    const seen = cloud.heartbeats.length;
    await until("waiting reported", () =>
      versions(cloud)
        .slice(seen)
        .some((v) => v.update.state === "waiting"),
    );
    await sleep(150);
    expect(host.activeJobs).toEqual([first.jobId]);
    expect(cloud.queue).toEqual([second]);
    expect(head(w.runner)).toBe(w.a);
    expect(updated).toBe(0);

    finish();
    await until("the restart", () => updated === 1);
    expect(aborted).toBe(false);
    expect(cloud.handbacks.get(first.jobId)?.outcome).toBe("completed");
    expect(cloud.queue).toEqual([second]);
    expect(head(w.runner)).toBe(w.c);
    await host.stop();
  });
});

describe("self-update: blocked (criterion 4)", () => {
  it("auto-update off", async () => {
    const w = await world();
    const u = await w.updater({ autoUpdate: false });
    expect(await u.check(w.c)).toEqual({ kind: "blocked", reason: "auto-update is off" });
    expect(await u.consider(w.c, true)).toBe("claim");
    expect(u.report()).toMatchObject({
      sha: w.a,
      autoUpdate: false,
      update: { state: "blocked", target: w.c, reason: "auto-update is off" },
    });
  });

  it("local changes, tracked or untracked", async () => {
    const w = await world();
    const u = await w.updater();
    writeFileSync(join(w.runner, "a.txt"), "changed");
    expect(await u.check(w.c)).toMatchObject({ reason: "the runner's checkout has local changes" });
    git(w.runner, "checkout", "--", "a.txt");
    writeFileSync(join(w.runner, "scratch.txt"), "x");
    expect(await u.check(w.c)).toMatchObject({ kind: "blocked" });
  });

  it("a branch other than main", async () => {
    const w = await world();
    git(w.runner, "checkout", "-q", "-b", "experiment");
    const u = await w.updater();
    expect(await u.check(w.c)).toEqual({
      kind: "blocked",
      reason: "the runner's checkout is on branch experiment, not main",
    });
  });

  it("a desired commit that isn't on origin/main", async () => {
    const w = await world();
    git(w.seed, "checkout", "-q", "-b", "feature");
    const f = commit(w.seed, "f.txt", "f");
    git(w.seed, "push", "-q", "origin", "feature");
    const u = await w.updater();
    expect(await u.check(f)).toEqual({
      kind: "blocked",
      reason: `${f.slice(0, 7)} is not on origin/main`,
    });
    // An unknown commit too.
    expect(await u.check("f".repeat(40))).toMatchObject({ kind: "blocked" });
  });

  it("a backwards move", async () => {
    const w = await world();
    git(w.runner, "pull", "-q", "--ff-only", "origin", "main");
    const u = await w.updater();
    expect(await u.check(w.b)).toEqual({
      kind: "blocked",
      reason: `updating to ${w.b.slice(0, 7)} would go backwards from ${w.c.slice(0, 7)}`,
    });
  });

  it("not a launchd service: reports, never moves", async () => {
    const w = await world();
    const u = await w.updater({ canRestart: false });
    expect(await u.consider(w.c, true)).toBe("claim");
    expect(u.report().update.state).toBe("blocked");
    expect(head(w.runner)).toBe(w.a);
  });

  it("the host carries on claiming on its current code, and logs each reason once", async () => {
    const w = await world();
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    cloud.desiredVersion = w.c;
    writeFileSync(join(w.runner, "a.txt"), "changed");
    const j = job();
    cloud.queue.push(j);
    const host = new RunnerHost({
      adapter: fakeAdapter(
        (x) => repo.host.clonePath(x),
        async (wt) => {
          writeFileSync(join(wt, "README.md"), "# scratch\nx\n");
          git(wt, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "x");
          return [{ type: "session.ended" as const, outcome: "completed" as const, summary: "" }];
        },
      ),
      cp: await controlPlane(cloud),
      git: repo.host,
      maxConcurrent: 1,
      heartbeatMs: 20,
      log: () => {},
      selfUpdate: await w.updater(),
      onUpdated: () => {
        throw new Error("must not update");
      },
    });
    await host.start();
    expect(host.activeJobs).toEqual([j.jobId]);
    await host.idle();
    await until("a few heartbeats", () => cloud.heartbeats.length >= 5);
    await host.stop();
    expect(cloud.handbacks.get(j.jobId)?.outcome).toBe("completed");
    expect(versions(cloud).at(-1)?.update).toEqual({
      state: "blocked",
      target: w.c,
      reason: "the runner's checkout has local changes",
    });
    expect(w.logs.filter((l) => l.includes("local changes"))).toHaveLength(1);
    expect(head(w.runner)).toBe(w.a);
  });
});

describe("rollback: bin/sf-runner-service (criterion 5)", () => {
  async function wrapperWorld() {
    const w = await world();
    const bin = join(w.root, "bin");
    mkdirSync(bin);
    const calls = join(w.root, "calls");
    const stub = (name: string, code: number) => {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >>"${calls}"\nexit ${code}\n`);
      chmodSync(join(bin, name), 0o755);
      return join(bin, name);
    };
    const node = stub("node", 1); // the new code crashes before its first heartbeat
    const pnpm = stub("pnpm", 0);
    const start = () =>
      spawnSync("/bin/sh", [join(w.runner, "local", "runner-host", "bin", "sf-runner-service")], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: w.root,
          SF_RUNNER_NODE: node,
          SF_RUNNER_PNPM: pnpm,
          SF_RUNNER_STATE_DIR: w.stateDir,
        },
        encoding: "utf8",
      });
    const callLog = () => readFileSync(calls, "utf8").trim().split("\n");
    return { ...w, start, callLog };
  }

  it("starts Node through the wrapper, as the service", async () => {
    const w = await wrapperWorld();
    const r = w.start();
    expect(r.status).toBe(1);
    expect(w.callLog()).toEqual([
      `node --experimental-transform-types --no-warnings ${join(execFileSync("realpath", [w.runner], { encoding: "utf8" }).trim(), "local", "runner-host", "src", "cli.ts")} run`,
    ]);
  });

  it("resets to the previous commit after three starts without a confirmation, and never retries it", async () => {
    const w = await wrapperWorld();
    const u = await w.updater();
    expect(await u.consider(w.c, true)).toBe("restart");
    expect(head(w.runner)).toBe(w.c);

    for (const n of [1, 2, 3]) {
      expect(w.start().status).toBe(1);
      expect(head(w.runner)).toBe(w.c);
      expect((await readUpdateRecord(w.stateDir))?.starts).toBe(n);
    }
    const fourth = w.start();
    expect(fourth.stderr).toMatch(/rolling back/);
    expect(head(w.runner)).toBe(w.a);
    expect(git(w.runner, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(w.runner, "status", "--porcelain")).toBe("");
    expect(w.callLog().filter((l) => l.startsWith("pnpm"))).toEqual([
      "pnpm install --frozen-lockfile",
    ]);
    expect(w.callLog().filter((l) => l.startsWith("node"))).toHaveLength(4);
    expect(await readUpdateRecord(w.stateDir)).toMatchObject({ status: "rolled_back", to: w.c });
    expect(await readRolledBack(w.stateDir)).toEqual([w.c]);

    // The old code starts again: it reports rolled_back and doesn't retry C.
    const again = await w.updater();
    expect(again.report()).toMatchObject({ sha: w.a, update: { state: "rolled_back" } });
    expect(await again.consider(w.c, true)).toBe("claim");
    expect(again.report().update).toMatchObject({ state: "rolled_back", target: w.c });
    expect(again.report().update.reason).toMatch(/didn't start/);
    expect(head(w.runner)).toBe(w.a);
    // A later deploy is taken as usual.
    const d = commit(w.seed, "d.txt", "d");
    git(w.seed, "push", "-q", "origin", "main");
    expect(await again.consider(d, true)).toBe("restart");
    expect(head(w.runner)).toBe(d);
  });

  it("a confirmed update isn't counted or rolled back", async () => {
    const w = await wrapperWorld();
    const u = await w.updater();
    await u.consider(w.c, true);
    w.start();
    await (await w.updater()).confirm();
    for (let i = 0; i < 4; i++) w.start();
    expect(head(w.runner)).toBe(w.c);
    expect(await readUpdateRecord(w.stateDir)).toMatchObject({ status: "confirmed", starts: 1 });
    expect(await readFile(join(w.stateDir, "update", "status"), "utf8")).toBe("confirmed\n");
  });
});
