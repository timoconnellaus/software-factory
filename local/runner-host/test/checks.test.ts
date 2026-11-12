import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSettings } from "@software-factory/harness-claude";
import {
  CHECK_FAILURE_MAX,
  checkFailureMessage,
  checkPassed,
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
  macUserDirs,
  processesUnder,
  SRT_VENDOR,
  sandboxAvailable,
  sandboxedExec,
  sandboxTrial,
  socketPathProblem,
  spawnCheck,
  toolchainPaths,
} from "../src/check-sandbox.ts";
import { checkLoop, duBytes, type Exec, GuardTripped, runChecks } from "../src/checks.ts";
import { paths } from "../src/config.ts";
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

/** A check's own dir as the host lays it out: `<checks dir>/<job>-…/r0-0/tree`. */
async function checkDirsIn(checksDir: string, job = "job_1-x") {
  const jobRoot = join(checksDir, job);
  const root = join(jobRoot, "r0-0");
  const dir = join(root, "tree");
  await mkdir(dir, { recursive: true });
  return { jobRoot, root, dir };
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

/** corepack beside the node on PATH (Node ≤ 24 ships it), or null. */
function corepackOnPath(): string | null {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const c = join(d, "corepack");
    if (d && existsSync(c) && existsSync(join(d, "node"))) return realpathSync(c) && c;
  }
  return null;
}
/** A host whose kernel refuses the sandbox (CI's AppArmor job): only the not-run test runs. */
const blocked = process.env.SF_EXPECT_SANDBOX_BLOCKED === "1";
const realSandbox = !blocked && (requireSandbox || sandboxAvailable());

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

  it("takes the harness's floor and more: none of the home, the runner's dirs, other checks, the job's allowlist, no loopback", () => {
    const root = "/t/sf-checks/job_1-x/r0-0";
    const s = checkSandboxSettings(
      j,
      { root, dir: `${root}/tree`, sockets: "/r/s/c123" },
      {
        protectPaths: ["/runner/config", "/runner/runs"],
        platform: "darwin",
        home: "/Users/o",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    expect(s.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        // the whole home, not only its credential stores
        "/Users/o",
        "/Users/o/.ssh",
        "/Users/o/Library/Keychains",
        "/runner/config",
        "/runner/runs",
        // the job's other checks, and other jobs'; this check's own dir is re-allowed
        "/t/sf-checks/job_1-x",
        "/t/sf-checks",
        // macOS (fourth review, S3): the shared temp dirs.
        "/tmp",
        "/private/tmp",
      ]),
    );
    expect(s.filesystem.allowRead).toEqual([
      `${root}/tree`,
      `${root}/home`,
      `${root}/tmp`,
      `${root}/store`,
      `${root}/empty`,
      `${root}/gitconfig`,
      "/r/s/c123",
      // srt's own helpers (Linux runs apply-seccomp inside the sandbox).
      ...(SRT_VENDOR ? [SRT_VENDOR] : []),
    ]);
    // Its own tree, home, temp and pnpm store: not the rest of its dir (the host's empty tool dirs
    // and git config), and no other check's.
    expect(s.filesystem.allowWrite).toEqual([
      `${root}/tree`,
      `${root}/home`,
      `${root}/tmp`,
      `${root}/store`,
    ]);
    expect(s.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        "/Users/o/.ssh",
        "/runner/config",
        "/runner/runs",
        `${root}/empty`,
        `${root}/gitconfig`,
      ]),
    );
    expect(s.network.allowedDomains).toEqual(
      expect.arrayContaining(["registry.npmjs.org", "example.org"]),
    );
    expect(s.network.strictAllowlist).toBe(true);
    // No loopback but the sandbox's own proxy.
    expect(s.network.allowLocalBinding).toBe(false);
  });

  it("re-allows only the toolchain under the home, never a dir that is, holds or sits in a denied one", async () => {
    const home = realpathSync(await scratch("sf-home-"));
    const nvm = join(home, ".nvm/versions/node/v24.1.0");
    const pnpmPkg = join(home, "setup-pnpm/node_modules/.pnpm/pnpm@10/node_modules/pnpm");
    const shims = join(home, "setup-pnpm/node_modules/.bin");
    const local = join(home, ".local/bin");
    for (const d of [
      join(nvm, "bin"),
      join(nvm, "lib/node_modules/corepack/dist"),
      join(pnpmPkg, "bin"),
      shims,
      local,
    ]) {
      await mkdir(d, { recursive: true });
    }
    await writeFile(join(nvm, "bin/node"), "");
    await writeFile(join(nvm, "lib/node_modules/corepack/dist/corepack.js"), "");
    await symlink(
      join(nvm, "lib/node_modules/corepack/dist/corepack.js"),
      join(nvm, "bin/corepack"),
    );
    await writeFile(join(pnpmPkg, "bin/pnpm.cjs"), "");
    await symlink(join(pnpmPkg, "bin/pnpm.cjs"), join(shims, "pnpm"));
    // A git straight in ~/.local/bin: its install would be ~/.local, which holds the runner's dirs.
    await writeFile(join(local, "git"), "");
    const allowed = toolchainPaths([join(nvm, "bin"), shims, local, "/usr/bin"].join(":"), home, [
      join(home, ".local/share/software-factory/runner"),
      join(home, ".ssh"),
    ]);
    expect(allowed).toEqual(
      [
        join(nvm, "bin"),
        nvm,
        join(nvm, "lib/node_modules/corepack"),
        join(home, "setup-pnpm/node_modules"),
        shims,
        pnpmPkg,
        local,
      ].sort(),
    );
    expect(allowed).not.toContain(join(home, ".local"));
    expect(allowed).not.toContain(home);
  });

  it("knows a socket dir too deep for the sandbox runtime's sockets", () => {
    expect(
      socketPathProblem("/Users/o/.local/share/software-factory/runner/s/cAbC123", "darwin"),
    ).toBeNull();
    // The check's own temp at the runner's real depth (what B1 of the third review hit).
    const deep =
      "/Users/someone/.local/share/software-factory/runner/checks/job_01JC0Z3V6Q4W8E2R5T7Y9U1I3O-AbC123/r0-0/tmp";
    expect(socketPathProblem(deep, "darwin")).toMatch(/too deep/);
    expect(socketPathProblem(deep.replace("/Users/", "/home/"), "linux")).toMatch(/too deep/);
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
      const { root, dir } = await checkDirsIn(parent);
      const sandbox = checkSandbox({ protectPaths: [outside], checksDir: parent });
      expect(sandbox).not.toBeNull();
      const exec = (sandbox as NonNullable<typeof sandbox>)(j, { root, dir });
      const probe = `.sf-check-probe-${process.pid}`;
      cleanups.push(() => rm(join(homedir(), probe), { force: true }));
      const r = await exec(
        {
          run: [
            `cat ${outside}/key && echo READ-PROTECTED`,
            `echo x > ${outside}/w && echo WROTE-OUTSIDE`,
            "echo x > /tmp/sf-check-probe-$$ && echo WROTE-TMP",
            `echo x > ${homedir()}/${probe} && echo WROTE-HOME`,
            "curl -sS -m 5 https://example.com >/dev/null && echo REACHED-NETWORK",
            "echo ok > here && cat here",
            // The command's temp is the check's own, never srt's shared /tmp/claude.
            'echo "TMPDIR=$TMPDIR"',
          ].join("; "),
          timeoutMs: 30_000,
        },
        never,
      );
      // On Linux a read-denied dir is an empty tmpfs inside the sandbox: a write there "works"
      // but never reaches the host. What counts is the host's files.
      expect(r.output).not.toMatch(/READ-PROTECTED|WROTE-TMP|REACHED-NETWORK/);
      await expect(readFile(join(outside, "w"), "utf8")).rejects.toThrow();
      await expect(readFile(join(homedir(), probe), "utf8")).rejects.toThrow();
      expect(r.output).toContain("ok");
      expect(await readFile(join(dir, "here"), "utf8")).toBe("ok\n");
      expect(r.output).toContain(`TMPDIR=${join(root, "tmp")}`);
    },
    60_000,
  );

  /** A check's dir in a scratch runner checks dir, and the real sandboxed exec for it. */
  async function realCheck(protectPaths: string[] = []) {
    const parent = await scratch("sf-checks-root-");
    const { jobRoot, root, dir } = await checkDirsIn(parent);
    const sandbox = checkSandbox({ protectPaths, checksDir: parent });
    if (!sandbox) throw new Error("no sandbox");
    return { parent, jobRoot, root, dir, exec: sandbox(j, { root, dir }) };
  }

  it.runIf(realSandbox)(
    "fails a check that prints a failure and signals itself or its shell (srt's CLI exits 0 there)",
    async () => {
      const { exec } = await realCheck();
      const run = (cmd: string) => exec({ run: cmd, timeoutMs: 30_000 }, never);
      // Never a pass: on macOS the command dies of the signal (null); on Linux srt's wrapper
      // shell reports it as 128 + the signal.
      const failed = (r: { exitCode: number | null }) =>
        expect(checkPassed({ exitCode: r.exitCode, timedOut: false })).toBe(false);
      failed(await run("echo 1 failing; kill -TERM $$"));
      failed(await run("echo 1 failing; kill -INT $$"));
      failed(await run(`node -e "console.log('1 failing'); process.kill(process.pid, 'SIGTERM')"`));
      // Nothing outside the sandbox can be signalled: the reporter above it survives.
      const parent = await run("kill -TERM $PPID; echo still-reported; exit 4");
      // macOS: the parent is outside the sandbox and the kill is refused (exit 4). Linux: it is
      // srt's own shell inside the sandbox (143). Either way the reporter answered, with a failure.
      expect(parent.output).not.toContain("no exit status");
      if (process.platform === "darwin") {
        // The kill is refused outside the sandbox, so the check runs on and exits 4.
        expect(parent).toMatchObject({
          exitCode: 4,
          output: expect.stringContaining("still-reported"),
        });
      } else {
        // srt's shell inside the sandbox dies (the echo may die with it): reported, not a pass.
        expect(checkPassed({ exitCode: parent.exitCode, timedOut: false })).toBe(false);
      }
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
      const { parent, jobRoot, root, exec } = await realCheck([secret]);
      await writeFile(join(parent, "job_2-y"), "another job's");
      // The first check tries everything a previous review used to switch the sandbox off: the
      // settings file srt used to read (gone), the host's files in the root, another job's root,
      // and a background loop that keeps trying after the check ends.
      const first = await exec(
        {
          run: [
            "ls ..",
            "for f in ../srt-settings.json ../gitconfig ../empty/npmrc ../../r0-1 ../../../job_2-y; do echo x > $f && echo WROTE $f; done",
            "(while :; do echo '{}' > ../srt-settings.json; sleep 0.1; done) &",
            "echo done",
          ].join("\n"),
          timeoutMs: 30_000,
        },
        never,
      );
      // On Linux the denied parent is an empty tmpfs inside the sandbox, so a write there "works"
      // and goes nowhere: the host's files are what count.
      expect(first.output).toContain("done");
      expect(await readFile(join(parent, "job_2-y"), "utf8")).toBe("another job's");
      expect(await readFile(join(root, "gitconfig"), "utf8")).toBe("");
      await expect(readFile(join(jobRoot, "r0-1"), "utf8")).rejects.toThrow();
      await expect(readFile(join(root, "empty", "npmrc"), "utf8")).resolves.toBe("");
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
  it.runIf(realSandbox)(
    "starts at the runner's real depth: the real paths() layout and a realistic job id, network through its proxy",
    async () => {
      // B1 of the third review: the check's temp under the real checks dir is too deep for the
      // sandbox runtime's sockets, so they go in the runner's short sockets dir.
      const real = paths();
      await mkdir(real.checksDir, { recursive: true, mode: 0o700 });
      const jobRoot = await mkdtemp(join(real.checksDir, "job_01JC0Z3V6Q4W8E2R5T7Y9U1I3O-"));
      cleanups.push(() => rm(jobRoot, { recursive: true, force: true }));
      const root = join(jobRoot, "r0-0");
      const dir = join(root, "tree");
      await mkdir(dir, { recursive: true });
      expect(socketPathProblem(join(root, "tmp"))).toMatch(/too deep/);
      const sandbox = checkSandbox({
        protectPaths: [real.configDir, real.runsDir],
        checksDir: real.checksDir,
        socketsDir: real.checkSocketsDir,
      });
      if (!sandbox) throw new Error("no sandbox");
      const r = await sandbox(j, { root, dir })(
        {
          run: `node -e "fetch('https://registry.npmjs.org/is-number').then((r) => console.log('registry', r.status), (e) => console.log('fetch failed', e.cause?.code ?? e.message))"`,
          timeoutMs: 60_000,
        },
        never,
      );
      expect(r.notRun).toBeUndefined();
      expect(r).toMatchObject({ exitCode: 0, output: expect.stringContaining("registry 200") });
      // Nothing of the check's sockets is left behind.
      expect(await readdir(real.checkSocketsDir)).toEqual([]);
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "keeps the home and the owner's loopback from a check: history, Claude's files, a project's .env, a local service",
    async () => {
      // Files like the ones the third review read from a check: in the real home, outside the
      // harness's credential deny list.
      const proj = await mkdtemp(join(homedir(), ".sf-check-home-probe-"));
      cleanups.push(() => rm(proj, { recursive: true, force: true }));
      await writeFile(join(proj, ".env"), "SECRET=from-the-owners-project");
      await writeFile(join(proj, ".zsh_history"), "owner typed this");
      const server = createServer((c) => c.end("owner's service")).listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      cleanups.push(() => new Promise((r) => server.close(() => r())));
      const port = (server.address() as { port: number }).port;
      const { exec } = await realCheck();
      const r = await exec(
        {
          run: [
            `cat ${proj}/.env; cat ${proj}/.zsh_history`,
            `ls ${homedir()} >/dev/null && echo LISTED-HOME`,
            `node -e "require('net').connect(${port}, '127.0.0.1').on('data', (d) => { console.log('LOOPBACK ' + d); process.exit(0) }).on('error', (e) => console.log('loopback refused', e.code))"`,
            // The toolchain is still there.
            "node -e \"console.log('node ' + process.version)\"",
            "git --version",
          ].join("\n"),
          timeoutMs: 60_000,
        },
        never,
      );
      expect(r.output).not.toMatch(
        /from-the-owners-project|owner typed this|LOOPBACK|owner's service/,
      );
      expect(r.output).toContain("loopback refused");
      expect(r.output).toMatch(/node v\d+/);
      expect(r.output).toMatch(/git version/);
      if (process.platform === "darwin") expect(r.output).not.toContain("LISTED-HOME");
    },
    120_000,
  );

  it.runIf(realSandbox && process.platform === "darwin")(
    "macOS (the weaker sandbox): no /tmp, /private/tmp or the user's /var/folders, and no launchctl",
    async () => {
      // Fourth review, S3: at the runner's real checks dir (under its data dir, not a temp dir).
      const real = paths();
      await mkdir(real.checksDir, { recursive: true, mode: 0o700 });
      const jobRoot = await mkdtemp(join(real.checksDir, "job_s3-"));
      cleanups.push(() => rm(jobRoot, { recursive: true, force: true }));
      const root = join(jobRoot, "r0-0");
      const dir = join(root, "tree");
      await mkdir(dir, { recursive: true });
      const inTmp = `/tmp/sf-s3-probe-${process.pid}`;
      // The user's real /var/folders temp, from the system: under turbo TMPDIR is unset.
      const userTemp = macUserDirs()[0];
      if (!userTemp) throw new Error("getconf DARWIN_USER_TEMP_DIR gave nothing");
      const inVar = join(userTemp, `sf-s3-probe-${process.pid}`);
      await writeFile(inTmp, "TMP-SECRET");
      await writeFile(inVar, "VARFOLDERS-SECRET");
      cleanups.push(() => rm(inTmp, { force: true }));
      cleanups.push(() => rm(inVar, { force: true }));
      const sandbox = checkSandbox({
        protectPaths: [real.configDir, real.runsDir],
        checksDir: real.checksDir,
        socketsDir: real.checkSocketsDir,
      });
      if (!sandbox) throw new Error("no sandbox");
      const r = await sandbox(j, { root, dir })(
        {
          run: [
            `cat ${inTmp} /private${inTmp} ${inVar}`,
            `ls ${dirname(realpathSync(userTemp))} >/dev/null 2>&1 && echo LISTED-VAR-FOLDERS`,
            "launchctl print gui/$(id -u) 2>&1 | head -3",
            "/bin/launchctl print gui/$(id -u) >/dev/null 2>&1 && echo LAUNCHCTL-WORKED",
            "echo ok > here && cat here",
          ].join("\n"),
          timeoutMs: 60_000,
        },
        never,
      );
      expect(r.notRun).toBeUndefined();
      expect(r.isolation).toBe("weaker-sandbox");
      expect(r.output).not.toMatch(
        /TMP-SECRET|VARFOLDERS-SECRET|LISTED-VAR-FOLDERS|LAUNCHCTL-WORKED|type = login/,
      );
      expect(r.output).toContain("ok");
    },
    120_000,
  );

  it.runIf(realSandbox && process.platform === "linux")(
    "Linux: a server the check starts is reachable on its own loopback, and a setsid escape dies with it",
    async () => {
      const { root, dir, exec } = await realCheck();
      const marker = `sf-escape-${process.pid}-${Date.now()}`;
      const r = await exec(
        {
          run: [
            // Fourth review, S5: a test that starts a server and talks to it.
            `node -e "const s = require('http').createServer((q, r) => r.end('pong')).listen(0, '127.0.0.1', async () => { console.log('server said ' + await (await fetch('http://127.0.0.1:' + s.address().port)).text()); s.close() })"`,
            // Fourth review, S1: the middle shell exits at once; the grandchild calls setsid.
            `d="$PWD"; ( ( cd / && exec perl -MPOSIX -e 'POSIX::setsid(); $0 = "${marker}"; while (1) { open(F, ">", $ARGV[0]); print F time; close F; sleep 1 }' "$d/alive" & ) & )`,
            "sleep 1; echo left-it",
          ].join("\n"),
          timeoutMs: 60_000,
        },
        never,
      );
      expect(r).toMatchObject({ exitCode: 0, isolation: "sandbox" });
      expect(r.output).toContain("server said pong");
      expect(r.output).toContain("left-it");
      const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout;
      expect(ps.split("\n").filter((l) => l.includes(marker))).toEqual([]);
      expect(await processesUnder(root)).toEqual([]);
      const before = await readFile(join(dir, "alive"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(await readFile(join(dir, "alive"), "utf8")).toBe(before);
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "never lets a check's leftover forge the next: a daemon that left the group and changed its cwd to /",
    async () => {
      // The third review's exploit: check 1 leaves a detached daemon (cwd /) that keeps writing PASS
      // wherever it can, including where check 2 will run; check 2 writes FAIL, waits, and passes
      // only if it reads PASS back.
      const parent = await scratch("sf-checks-root-");
      const jobRoot = join(parent, "job_1-x");
      const marker = `sf-forger-${process.pid}-${Date.now()}`;
      const forger = [
        "const fs = require('fs'), path = require('path'), cp = require('child_process');",
        "if (process.argv[2] !== 'child') {",
        "  const targets = ['result', '../../r0-1/tree/result', '../../r0-1/home/result', '../home/result'].map((p) => path.resolve(p));",
        `  cp.spawn(process.execPath, [__filename, 'child', '${marker}', ...targets], { detached: true, cwd: '/', stdio: 'ignore' }).unref();`,
        "} else {",
        "  setInterval(() => { for (const f of process.argv.slice(4)) { try { fs.writeFileSync(f, 'PASS'); } catch {} } }, 20);",
        "}",
      ].join("\n");
      const sandbox = checkSandbox({ protectPaths: [], checksDir: parent });
      if (!sandbox) throw new Error("no sandbox");
      const out = await checkLoop({
        ...loopBase(jobRoot),
        checks: {
          commands: [
            {
              name: "install",
              run: "node forger.js && sleep 0.5 && echo left-a-daemon",
              timeoutMs: 30_000,
            },
            {
              name: "tests",
              run: "echo FAIL > result; sleep 1.5; cat result; grep -q PASS result",
              timeoutMs: 30_000,
            },
          ],
          fixRounds: 0,
        },
        exportTree: async (_sha, dir) => writeFile(join(dir, "forger.js"), forger),
        exec: (dir) => sandbox(j, { root: dirname(dir), dir }),
        commit: async () => SHA,
      });
      const daemons = async () => {
        const ps = await new Promise<string>((resolve) => {
          const p = spawn("ps", ["-A", "-o", "pid=,command="], {
            stdio: ["ignore", "pipe", "ignore"],
          });
          let t = "";
          p.stdout.on("data", (c: Buffer) => {
            t += c.toString();
          });
          p.on("close", () => resolve(t));
        });
        return ps
          .split("\n")
          .filter((l) => l.includes(marker))
          .map((l) => Number(l.trim().split(/\s+/)[0]));
      };
      const left = await daemons();
      cleanups.push(async () => {
        for (const pid of await daemons()) process.kill(pid, "SIGKILL");
      });
      expect(out.final[0]).toMatchObject({ name: "install", exitCode: 0 });
      // The forge failed: check 2's own FAIL stands.
      expect(out.final[1]).toMatchObject({ name: "tests", exitCode: 1 });
      expect(out.final[1]?.logTail).toContain("FAIL");
      // Linux: the daemon died with the sandbox's pid namespace. macOS: the host's process tracker
      // kills it when it saw it (defence in depth; the property above is what is guaranteed).
      if (process.platform === "linux") expect(left).toEqual([]);
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "runs the documented install check end to end on a real pnpm workspace, with a store of its own",
    async () => {
      const fixture = fileURLToPath(new URL("./fixtures/pnpm-workspace", import.meta.url));
      const parent = await scratch("sf-checks-root-");
      const jobRoot = join(parent, "job_1-x");
      const sandbox = checkSandbox({ protectPaths: [], checksDir: parent });
      if (!sandbox) throw new Error("no sandbox");
      const out = await checkLoop({
        ...loopBase(jobRoot),
        checks: {
          commands: [
            {
              name: "install",
              run: "pnpm install --frozen-lockfile && pnpm store path",
              timeoutMs: 300_000,
            },
            { name: "tests", run: "pnpm test", timeoutMs: 120_000 },
          ],
          fixRounds: 0,
        },
        exportTree: (_sha, dir) => cp(fixture, dir, { recursive: true }),
        exec: (dir) => sandbox(j, { root: dirname(dir), dir }),
        commit: async () => SHA,
      });
      const [install, tests] = out.final;
      expect(install, install?.logTail).toMatchObject({ exitCode: 0 });
      // The store is the check's own, beside its tree: not the agent's, not another job's.
      expect(install?.logTail).toContain(join(jobRoot, "r0-0", "store"));
      expect(tests, tests?.logTail).toMatchObject({ exitCode: 0 });
      expect(tests?.logTail).toContain("a: is-number works");
    },
    600_000,
  );

  it.runIf(realSandbox && corepackOnPath())(
    "runs pnpm through corepack's shim inside the sandbox: corepack fetches pnpm through the proxy",
    async () => {
      const fixture = fileURLToPath(new URL("./fixtures/pnpm-workspace", import.meta.url));
      const { root, dir } = await checkDirsIn(await scratch("sf-checks-root-"));
      await cp(fixture, dir, { recursive: true });
      const parent = dirname(dirname(root));
      const sandbox = checkSandbox({ protectPaths: [], checksDir: parent });
      if (!sandbox) throw new Error("no sandbox");
      // corepack's own pnpm shim, first on the check's PATH.
      const corepack = corepackOnPath() as string;
      const r = await sandbox(j, { root, dir })(
        {
          run: `${corepack} pnpm --version && ${corepack} pnpm install --frozen-lockfile && ${corepack} pnpm test`,
          timeoutMs: 300_000,
        },
        never,
      );
      expect(r, r.output).toMatchObject({ exitCode: 0 });
      expect(r.output).toContain("10.23.0");
      expect(r.output).toContain("a: is-number works");
    },
    600_000,
  );

  it.runIf(blocked)(
    "reports every check not run where the kernel refuses the sandbox (AppArmor's restriction left on)",
    async () => {
      const parent = await scratch("sf-checks-root-");
      const trial = await sandboxTrial({ protectPaths: [], checksDir: parent });
      expect(trial.ok).toBe(false);
      const sandbox = checkSandbox({ protectPaths: [], checksDir: parent });
      if (!sandbox)
        throw new Error("the binaries are installed: the trial is what must catch this");
      const out = await checkLoop({
        ...loopBase(join(parent, "job_1-x")),
        checks: { commands: [{ name: "tests", run: "echo ran", timeoutMs: 30_000 }], fixRounds: 2 },
        exec: (dir) => sandbox(j, { root: dirname(dir), dir }),
        commit: async () => SHA,
        continueSession: async () => {
          throw new Error("a not-run check must never go to a fix round");
        },
      });
      expect(out.rounds).toBe(0);
      expect(out.final).toMatchObject([
        { exitCode: null, notRun: expect.stringContaining("the sandbox could not start") },
      ]);
      expect(out.final[0]?.logTail).not.toContain("ran");
    },
    120_000,
  );

  it.runIf(realSandbox)(
    "passes its start-up trial where the sandbox works",
    async () => {
      expect(
        await sandboxTrial({ protectPaths: [], checksDir: await scratch("sf-checks-root-") }),
      ).toEqual({
        ok: true,
      });
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
    expect(seen).toEqual([join(root, "r0-0", "tree")]);
  });

  it("gives each check a dir of its own: a copy of the tree the check before left, made after it ended", async () => {
    const root = await scratch();
    const seen: string[] = [];
    const out = await checkLoop({
      ...loopBase(root),
      checks: {
        commands: [
          { name: "install", run: "install", timeoutMs: 1_000 },
          { name: "tests", run: "tests", timeoutMs: 1_000 },
        ],
        fixRounds: 0,
      },
      exportTree: async (_sha, dir) => {
        await writeFile(join(dir, "from-export"), "x");
      },
      exec: (dir) => async (c) => {
        seen.push(dir);
        if (c.run === "install") {
          await mkdir(join(dir, "node_modules"), { recursive: true });
          await writeFile(join(dir, "node_modules", "dep.js"), "installed");
          await symlink("/etc/hosts", join(dir, "node_modules", "link"));
          return { exitCode: 0, timedOut: false, output: "" };
        }
        const dep = await readFile(join(dir, "node_modules", "dep.js"), "utf8");
        const link = await readlink(join(dir, "node_modules", "link"));
        // The install's dir is gone: whatever it left running can't reach this one.
        const prevGone = await readFile(join(root, "r0-0", "tree", "from-export"), "utf8").then(
          () => false,
          () => true,
        );
        return { exitCode: 0, timedOut: false, output: `${dep} ${link} ${prevGone}` };
      },
      commit: async () => SHA,
    });
    expect(seen).toEqual([join(root, "r0-0", "tree"), join(root, "r0-1", "tree")]);
    // The symlink is copied as it is, never followed.
    expect(out.final[1]?.logTail).toBe("installed /etc/hosts true");
    expect(await readdir(root)).toEqual([]);
  });

  it("doesn't carry a tree past the runner's disk bound: the next check is not run, and no fix round", async () => {
    const root = await scratch();
    const ran: string[] = [];
    const out = await checkLoop({
      ...loopBase(root),
      checks: {
        commands: [
          { name: "install", run: "install", timeoutMs: 1_000 },
          { name: "tests", run: "tests", timeoutMs: 1_000 },
        ],
        fixRounds: 2,
      },
      maxTreeBytes: 10 * 1024 ** 3,
      treeBytes: async () => 12 * 1024 ** 3,
      exec: () => async (c) => {
        ran.push(c.run);
        return { exitCode: 0, timedOut: false, output: "" };
      },
      commit: async () => SHA,
      continueSession: async () => {
        throw new Error("a tree over the bound must never go to a fix round");
      },
    });
    expect(ran).toEqual(["install"]);
    expect(out.final[1]).toMatchObject({ name: "tests", exitCode: null });
    expect(out.final[1]?.notRun).toMatch(/12\.0 GB, over this runner's bound of 10\.0 GB/);
    expect(await readdir(root)).toEqual([]);
  });

  it("stops a check whose dir grows past the disk bound while it runs, and reports the limit", async () => {
    const root = await scratch();
    let killed = false;
    const out = await checkLoop({
      ...loopBase(root),
      checks: { commands: [{ name: "tests", run: "fill", timeoutMs: 60_000 }], fixRounds: 2 },
      maxTreeBytes: 10 * 1024 ** 3,
      treeWatchMs: 5,
      // The check's own dir, measured while it runs: over the bound on the second look.
      treeBytes: (() => {
        let n = 0;
        return async (dir: string) => {
          expect(dir).toBe(join(root, "r0-0"));
          return ++n > 1 ? 11 * 1024 ** 3 : 1024;
        };
      })(),
      exec: () => (_c, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            killed = true;
            resolve({ exitCode: null, timedOut: false, output: "writing…" });
          });
        }),
      commit: async () => SHA,
      continueSession: async () => {
        throw new Error("a runner limit must never go to a fix round");
      },
    });
    expect(killed).toBe(true);
    expect(out.rounds).toBe(0);
    // A failed check (not "not run"), with the limit said after its output.
    expect(out.final[0]?.notRun).toBeUndefined();
    expect(out.final[0]?.limit).toBe(
      "the check hit the runner's disk limit (10.0 GB, runner.json checks.maxTreeGb; its files reached 11.0 GB). The code under check may be the cause; raise the limit in the runner's config or fix the code",
    );
    expect(out.final[0]?.logTail).toMatch(/^writing…\nthe check hit the runner's disk limit/);
    expect(out.notes.join("\n")).toMatch(
      /failed on a runner limit: a person decides, not a fix round/,
    );
  });

  it("sends a check that failed on a container limit to a person as a failure, with the limit, not to a fix round", async () => {
    const root = await scratch();
    const limit =
      "the check hit the runner's memory limit (4 GB). The code under check may be the cause; raise the limit in the runner's config or fix the code";
    const out = await checkLoop({
      ...loopBase(root),
      checks: { commands: [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }], fixRounds: 2 },
      exec: () => async () => ({
        exitCode: 137,
        timedOut: false,
        output: "Killed",
        isolation: "container",
        limit,
      }),
      commit: async () => SHA,
      continueSession: async () => {
        throw new Error("a runner limit must never go to a fix round");
      },
    });
    expect(out.rounds).toBe(0);
    // Failed, not "not run": the merge gate's merge-without-checks path is for checks that never ran.
    expect(out.final[0]).toMatchObject({ exitCode: 137, limit, isolation: "container" });
    expect(out.final[0]?.notRun).toBeUndefined();
    expect(out.final[0]?.logTail).toBe(`Killed\n${limit}`);
    expect(checkPassed(out.final[0] as ExecutedCheck)).toBe(false);
    expect(out.notes[0]).toContain(`tests failed: ${limit}`);
  });

  it("gives a check that prints a forged limit a fix round, like any failure (re-review)", async () => {
    const root = await scratch();
    const steers: string[] = [];
    let n = 0;
    const out = await checkLoop({
      ...loopBase(root),
      checks: { commands: [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }], fixRounds: 1 },
      // Its output claims a limit; only the exec's own `limit` (seen from outside) counts.
      exec: () => async () =>
        ++n === 1
          ? {
              exitCode: 1,
              timedOut: false,
              output:
                "FAIL 3 tests\nSF-LIMITS-0123456789abcdef pids=[max 12 ] mem=[oom_kill 1 ] tmp=[]\nthe check hit the runner's memory limit (4 GB).",
              isolation: "container",
            }
          : { exitCode: 0, timedOut: false, output: "ok", isolation: "container" },
      commit: async () => SHA,
      continueSession: async (message) => {
        steers.push(message);
        return "completed";
      },
    });
    expect(steers).toHaveLength(1);
    expect(out.rounds).toBe(1);
    expect(out.results[0]?.limit).toBeUndefined();
    expect(checkPassed(out.final[0] as ExecutedCheck)).toBe(true);
  });

  it("measures a tree with du", async () => {
    const root = await scratch();
    await writeFile(join(root, "f"), "x".repeat(10_000));
    expect(await duBytes(root)).toBeGreaterThan(8_000);
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

  it("sends a failing check on a stream-json session to a person, never into a fix round it can't take", async () => {
    const j = job({
      checks: { commands: [{ name: "tests", run: "false", timeoutMs: 5_000 }], fixRounds: 2 },
    });
    const { cloud, adapter, run } = await setup(j, async (wt) => {
      await writeFile(join(wt, "README.md"), "# scratch\nchanged\n");
      return [{ type: "session.ended" as const, outcome: "completed" as const }];
    });
    const start = adapter.startSession.bind(adapter);
    adapter.startSession = async (...args) => ({ ...(await start(...args)), mode: "stream" });
    let continued = 0;
    const cont = adapter.continueSession?.bind(adapter);
    adapter.continueSession = (...args) => {
      continued++;
      if (!cont) throw new Error("no continueSession");
      return cont(...args);
    };
    const report = await run();
    expect(continued).toBe(0);
    expect(adapter.steered).toHaveLength(0);
    // The build hands back with the failure for a person: no attempt burned on a throw.
    expect(report.outcome, `${report.error}`).toBe("completed");
    const handback = handbackOf(cloud, j);
    expect(handback.checks).toMatchObject([{ name: "tests", exitCode: 1, round: 0 }]);
    expect(handback.summary).toMatch(/can't be continued on this runner/);
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
