// A container per job (ADR 0661). The job repo and its check run on real git; the container run
// needs the real Docker and tmux (skipped when either is missing). It builds a small test image,
// then runs a stand-in `claude` (a Node script, mounted read only) in the job's container under
// tmux, through the harness's real launch script and status hook and the real launch check inside
// the container. The stand-in probes its own confinement and reports what it found.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunchRecord } from "@software-factory/harness-claude";
import { type AdapterEvent, RESULT_FILE, type RepoJob } from "@software-factory/runner-contract";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ContainerSpec,
  checkJobGitDir,
  containerAccount,
  containerReadCommand,
  createContainerRunner,
  createJobRepo,
  dockerRunArgs,
  dockerRuntime,
  JOB_LABEL,
  nodeExec,
  reapContainers,
} from "../src/index.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qm", message);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function scratch(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("the job repo", () => {
  it("repairs a tampered git dir and reports it", async () => {
    const root = await scratch("sf-repo-");
    const checkout = join(root, "c");
    await mkdir(checkout);
    git(checkout, "init", "-q", "-b", "main");
    await writeFile(join(checkout, "a"), "a\n");
    git(checkout, "add", ".");
    commit(checkout, "a");
    git(checkout, "branch", "private");
    const repo = await createJobRepo({
      exec: nodeExec,
      checkout,
      work: join(root, "work"),
      gitDir: join(root, "git"),
      jobId: "job_x",
      branch: "factory/1-x",
      start: "main",
    });
    // Only the start point, on the job's branch; the checkout's other branches stay out.
    expect(git(repo.work, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/factory/1-x");
    expect(git(checkout, "for-each-ref", "--format=%(refname)", "refs/software-factory")).toBe("");
    expect(await checkJobGitDir(repo)).toEqual([]);
    const evil = join(root, "evil");
    await mkdir(evil);
    await writeFile(join(repo.gitDir, "commondir"), `${evil}\n`);
    await writeFile(
      join(repo.gitDir, "objects", "info", "alternates"),
      `${checkout}/.git/objects\n`,
    );
    await writeFile(join(repo.gitDir, "hooks", "pre-commit"), "#!/bin/sh\ntouch /tmp/pwned\n");
    await writeFile(join(repo.gitDir, "config"), "[core]\n\tfsmonitor = touch /tmp/pwned\n");
    await rm(join(repo.gitDir, "refs", "tags"), { recursive: true });
    await symlink(evil, join(repo.gitDir, "refs", "tags"));
    await writeFile(join(repo.work, ".git"), `gitdir: ${evil}\n`);
    const problems = (await checkJobGitDir(repo)).join("\n");
    for (const found of [
      /\.git was changed/,
      /commondir/,
      /alternates/,
      /config was changed/,
      /hooks were changed/,
      /symlink: refs\/tags/,
    ]) {
      expect(problems).toMatch(found);
    }
    // Put back: the host's git works on it again, with the factory's config.
    expect(await checkJobGitDir(repo)).toEqual([]);
    expect(git(repo.work, "config", "--get", "core.fsmonitor")).toBe("false");
    expect(git(repo.work, "rev-parse", "HEAD")).toBe(repo.baseSha);
  });
});

describe("the container", () => {
  const spec: ContainerSpec = {
    name: "sf-job_1",
    image: "sha256:abc",
    user: "501:20",
    workdir: "/w",
    script: "/r/launch.sh",
    env: { HOME: "/h" },
    mounts: [
      { path: "/w", readOnly: false },
      { path: "/r", readOnly: true },
    ],
    labels: { [JOB_LABEL]: "job_1" },
  };

  it("runs locked down, on a terminal for tmux and on pipes for a stream session", () => {
    const tty = dockerRunArgs(spec, true);
    for (const flag of ["--read-only", "--init", "--rm", "-t", "no-new-privileges"]) {
      expect(tty).toContain(flag);
    }
    expect(tty.join(" ")).toContain("--cap-drop ALL");
    expect(tty.join(" ")).toContain("type=bind,src=/r,dst=/r,readonly");
    expect(tty.slice(-3)).toEqual(["/bin/sh", "sha256:abc", "/r/launch.sh"]);
    expect(dockerRunArgs(spec, false)).not.toContain("-t");
    expect(dockerRunArgs(spec, false)).toContain("-i");
    expect(() =>
      dockerRunArgs({ ...spec, mounts: [{ path: "/a,b", readOnly: false }] }, true),
    ).toThrow(/can't mount/);
  });

  it("needs a token account: a login can't go into a container", () => {
    expect(() => containerAccount({ name: "me", configDir: "/c" }, "/h")).toThrow(
      /isn't a token account.*setup-token/,
    );
    expect(
      containerAccount(
        { name: "t", configDir: "/c", token: { file: "/t", env: "CLAUDE_CODE_OAUTH_TOKEN" } },
        "/h",
      ),
    ).toEqual({
      name: "t",
      configDir: "/h/.claude",
      token: { file: "/t", env: "CLAUDE_CODE_OAUTH_TOKEN" },
    });
  });
});

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const hasDocker =
  (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  }).stdout?.trim().length ?? 0) > 0;
const SOCKET = `sf-ctest-${process.pid}`;
const TOKEN = "sk-ant-oat01-integration-test-not-a-real-token-0123456789";
const RUNNER = `r_test${process.pid}`;

/** A small image with what the stand-in needs: Node, git and ps. */
const TEST_DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git procps && rm -rf /var/lib/apt/lists/*
`;

/**
 * The stand-in for Claude Code, run by the image's Node. It runs the projected hooks the way Claude
 * does, applies the settings' env to its commands, probes its confinement and commits.
 */
const FAKE_CLAUDE = `#!/usr/local/bin/node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const settingsPath = args[args.indexOf("--settings") + 1];
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const env = { ...process.env };
for (const [k, v] of Object.entries(settings.env ?? {})) {
  if (v === "") delete env[k];
  else env[k] = v;
}
const hook = (event, input = {}) => {
  for (const entry of settings.hooks?.[event] ?? []) {
    for (const h of entry.hooks) {
      spawnSync("/bin/sh", ["-c", h.command], {
        input: JSON.stringify({ hook_event_name: event, ...input }),
      });
    }
  }
};
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const next = async () => (await lines.next()).value ?? "";
console.log("stand-in claude up");
hook("SessionStart", { source: "startup" });
const pointer = await next();
hook("UserPromptSubmit", { prompt: pointer });
const probe = JSON.parse(readFileSync(".factory-prompt.md", "utf8"));
const work = process.cwd();
const runDir = dirname(settingsPath);
const gitDir = readFileSync(".git", "utf8").replace(/^gitdir: /, "").trim();
const attempt = (path) => {
  try {
    writeFileSync(path, "x");
    return "written";
  } catch (e) {
    return e.code ?? String(e);
  }
};
const r = {};
r.mode = args[args.indexOf("--permission-mode") + 1];
r.user = (await import("node:os")).userInfo().username;
r.sandbox = settings.sandbox.enabled;
r.token = process.env.CLAUDE_CODE_OAUTH_TOKEN === probe.token;
r.configDir = process.env.CLAUDE_CONFIG_DIR;
r.home = process.env.HOME;
r.hostHome = existsSync(probe.hostHome);
r.sentinel = (() => {
  try {
    return readFileSync(probe.sentinel, "utf8");
  } catch (e) {
    return e.code;
  }
})();
r.mustFail = Object.fromEntries(
  [
    "/etc/sf-test",
    "/usr/local/bin/sf-test",
    join(runDir, "sf-test"),
    settingsPath,
    join(work, ".claude", "sf-test"),
    join(work, ".git"),
    join(gitDir, "config"),
    join(gitDir, "hooks", "pre-commit"),
    join(gitDir, "objects", "info", "alternates"),
  ].map((p) => [p, attempt(p)]),
);
r.mayWrite = Object.fromEntries(
  [join(work, "ok.txt"), join(process.env.HOME, "sf-test"), "/tmp/sf-test"].map((p) => [p, attempt(p)]),
);
hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "git commit" } });
const add = spawnSync("git", ["add", "ok.txt"], { env, encoding: "utf8" });
const commit = spawnSync("git", ["commit", "-qm", "from the container"], { env, encoding: "utf8" });
r.commit = add.status + " " + commit.status + " " + (commit.stderr || "").trim();
hook("PostToolUse", { tool_name: "Bash" });
writeFileSync("${RESULT_FILE}", JSON.stringify(r));
hook("Stop", {});
await new Promise(() => {});
`;

describe.skipIf(!hasTmux || !hasDocker)("a container job on the real Docker", () => {
  const runtime = dockerRuntime();
  afterAll(() => {
    spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
  });

  it("confines the agent, lets the host push its commit, and releases cleanly", {
    timeout: 15 * 60_000,
  }, async () => {
    const root = await scratch("sf-ctr-it-");
    const seed = join(root, "projects", "app");
    await mkdir(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "remote", "add", "origin", "https://github.com/acme/app.git");
    await writeFile(join(seed, "README.md"), "# scratch\n");
    git(seed, "add", ".");
    commit(seed, "init");
    const bare = join(root, "origin.git");
    git(root, "clone", "-q", "--bare", seed, bare);
    const sentinel = join(root, "host-secret.txt");
    await writeFile(sentinel, "the host's secret\n");
    const fake = join(root, "fake");
    await mkdir(fake);
    await writeFile(join(fake, "claude"), FAKE_CLAUDE);
    await chmod(join(fake, "claude"), 0o755);
    const tokenFile = join(root, "token");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

    const worktreesDir = join(root, "worktrees");
    const runsDir = join(root, "runs");
    const runner = createContainerRunner({
      checkouts: [join(root, "projects")],
      resolveRepoPath: () => {
        throw new Error("the checkout should have been found");
      },
      worktreesDir,
      runsDir,
      startPoint: () => "main",
      pollMs: 100,
      screenLogMs: 0,
      startTimeoutMs: 60_000,
      tmux: { socket: SOCKET },
      account: () => ({
        name: "test",
        configDir: join(root, "account"),
        token: { file: tokenFile, env: "CLAUDE_CODE_OAUTH_TOKEN" },
      }),
      container: {
        runtime,
        runnerId: RUNNER,
        dockerfile: TEST_DOCKERFILE,
        claudeBin: join(fake, "claude"),
        extraMounts: [{ path: fake, readOnly: true }],
        log: (m) => console.log(m),
        // `ps` shows `<node> <script> <args>` for the stand-in script: drop the interpreter.
        readCommand: (rt, name) => {
          const read = containerReadCommand(rt, name);
          return async (pid) => (await read(pid))?.replace(/^\S+\s+/, "") ?? null;
        },
      },
    });
    const job: RepoJob = {
      jobId: "job_ctr1",
      runId: "run_1",
      runNo: 1,
      stage: "flow",
      workItem: { id: "wi_1", number: 7, title: "Add a line" },
      repo: { url: "https://github.com/acme/app.git", owner: "acme", name: "app", baseRef: "main" },
      branch: "factory/flow-app-7",
      harness: {
        id: "claude-code",
        role: "implement",
        prompt: JSON.stringify({ token: TOKEN, hostHome: homedir(), sentinel }),
      },
      context: {},
      requires: [],
      limits: { sessionTimeoutMs: 120_000 },
      lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    };
    const signal = new AbortController().signal;
    expect((await runner.manifest()).capabilities).toContain("container-isolation");
    const ws = await runner.prepareWorkspace(job, signal);
    cleanups.push(() => runner.release(job, ws, undefined).catch(() => {}));
    expect((await readLaunchRecord(ws.runDir))?.mode).toBe("bypassPermissions");
    const session = await runner.startSession(job, ws, signal);
    expect(session.takeover?.hint).toBe(`tmux -L ${SOCKET} attach -t sf-job_ctr1`);

    const events: AdapterEvent[] = [];
    for await (const e of runner.events(job, session, signal)) events.push(e);
    const r = JSON.parse(await readFile(join(ws.path, RESULT_FILE), "utf8"));
    expect(events.at(-1), JSON.stringify(r, null, 2)).toMatchObject({
      type: "session.ended",
      outcome: "completed",
    });

    // Permissions off, Claude's own sandbox off: the container is the floor.
    expect(r.mode).toBe("bypassPermissions");
    expect(["agent", "node"]).toContain(r.user);
    expect(r.sandbox).toBe(false);
    // The token reached Claude, with a fresh config dir; the host home and the file next to the
    // job did not.
    const jobRoot = join(await realpath(worktreesDir), "sf-job_ctr1");
    expect(r.token).toBe(true);
    expect(r.home).toBe(join(jobRoot, "home"));
    expect(r.configDir).toBe(join(jobRoot, "home", ".claude"));
    expect(r.hostHome).toBe(false);
    expect(r.sentinel).toBe("ENOENT");
    for (const [path, outcome] of Object.entries(r.mustFail)) {
      expect(outcome, path).toMatch(/^(EROFS|EACCES|EBUSY|EPERM)$/);
    }
    for (const [path, outcome] of Object.entries(r.mayWrite)) expect(outcome, path).toBe("written");

    // The agent's commit, pushed by the host (outside the container) from the job repo.
    expect(r.commit).toBe("0 0 ");
    expect(git(ws.path, "log", "-1", "--format=%s %an")).toBe(
      "from the container Software Factory",
    );
    git(
      ws.path,
      "-c",
      "protocol.file.allow=always",
      "push",
      "-q",
      bare,
      `HEAD:refs/heads/${job.branch}`,
    );
    expect(git(bare, "log", "-1", "--format=%s", job.branch)).toBe("from the container");
    // The checkout itself gained nothing.
    expect(git(seed, "branch", "--list")).toBe("* main");

    await runner.release(job, ws, session);
    await runner.release(job, ws, session);
    expect(await runtime.containers(`${JOB_LABEL}=job_ctr1`)).toEqual([]);
    expect(existsSync(jobRoot)).toBe(false);
    expect(existsSync(join(runsDir, "job_ctr1"))).toBe(false);
    expect(await reapContainers(runtime, RUNNER, new Set())).toEqual([]);
  });
});
