// A container job on the real Docker and tmux (skipped when either is missing). It builds the real
// agent image, then runs a stand-in `claude` (a Node script, mounted read only) in the job's
// container under tmux, through the harness's real launch script and status hook, with the real
// launch check inside the container. The stand-in probes its own confinement and reports:
//
// - it can't see the host home or a file next to its job dir;
// - it reaches an allowlisted host only through the proxy, gets 403 for another, and has no route
//   (and no DNS) without the proxy;
// - it can write its working tree, home and /tmp, and nothing else (root, run dir, settings,
//   `.claude/`, `.git`, the git dir's config, hooks and alternates);
// - it can commit, and the host can push that commit.
//
// Then steering through tmux reaches it, and release leaves nothing behind.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type AdapterEvent, type Job, RESULT_FILE } from "@software-factory/runner-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  containerReadCommand,
  createContainerRunner,
  dockerRuntime,
  ensureImage,
  JOB_LABEL,
  tmuxCli,
} from "../src/index.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const hasDocker =
  spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  }).stdout?.trim().length > 0;
const SOCKET = `sf-ctest-${process.pid}`;
const TOKEN = "sk-ant-oat01-integration-test-not-a-real-token-0123456789";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

/**
 * The stand-in for Claude Code, run by the image's Node. It runs the projected hooks the way Claude
 * does, applies the settings' env to its commands (as Claude does), and probes its confinement.
 */
const FAKE_CLAUDE = `#!/usr/local/bin/node
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
r.token = process.env.CLAUDE_CODE_OAUTH_TOKEN === probe.token;
r.home = process.env.HOME;
r.hostHome = existsSync(probe.hostHome);
r.sentinel = (() => {
  try {
    return readFileSync(probe.sentinel, "utf8");
  } catch (e) {
    return e.code;
  }
})();
r.root = readdirSync("/").sort();
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
r.allowed = await fetch(probe.allowedUrl).then(
  async (res) => res.status + " " + (await res.text()),
  (e) => "error " + (e.cause?.code ?? e.message),
);
// Node's fetch tunnels plain HTTP through CONNECT too; curl sends it as an absolute-URI request.
r.deniedHttp = await fetch("http://example.com/").then((res) => res.status, () => "blocked");
r.deniedCurl = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://example.com/"], { encoding: "utf8" }).stdout;
r.allowedCurl = spawnSync("curl", ["-s", probe.allowedUrl], { encoding: "utf8" }).stdout;
r.deniedHttps = await fetch("https://example.com/").then(() => "reached", () => "blocked");
r.direct = await new Promise((resolve) => {
  const s = connect(80, "1.1.1.1");
  s.setTimeout(3000, () => { s.destroy(); resolve("timeout"); });
  s.on("connect", () => { s.destroy(); resolve("connected"); });
  s.on("error", (e) => resolve(e.code));
});
r.dns = await lookup("example.com").then(() => "resolved", (e) => e.code);
hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "git commit" } });
const add = spawnSync("git", ["add", "ok.txt"], { env, encoding: "utf8" });
const commit = spawnSync("git", ["commit", "-qm", "from the container"], { env, encoding: "utf8" });
r.commit = add.status + " " + commit.status + " " + (commit.stderr || "").trim();
hook("PostToolUse", { tool_name: "Bash" });
writeFileSync("${RESULT_FILE}", JSON.stringify(r));
const steer = await next();
writeFileSync("steered.txt", steer);
hook("UserPromptSubmit", { prompt: steer });
hook("Stop", {});
await new Promise(() => {});
`;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
});

describe.skipIf(!hasTmux || !hasDocker)("a container job on the real Docker", () => {
  const runtime = dockerRuntime();
  beforeAll(async () => {
    // The real image: the first run on a machine downloads the base and Claude Code.
    await ensureImage(runtime, { log: (m) => console.log(m) });
  }, 20 * 60_000);

  it("confines the agent, lets the host push its commit, takes steering, releases cleanly", {
    timeout: 180_000,
  }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-ctr-it-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const seed = join(root, "projects", "app");
    await mkdir(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    git(seed, "remote", "add", "origin", "https://github.com/acme/app.git");
    await writeFile(join(seed, "README.md"), "# scratch\n");
    git(seed, "add", ".");
    git(seed, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-qm", "init");
    const bare = join(root, "origin.git");
    git(root, "clone", "-q", "--bare", seed, bare);
    const sentinel = join(root, "host-secret.txt");
    await writeFile(sentinel, "the host's secret\n");
    const fake = join(root, "fake");
    await mkdir(fake);
    await writeFile(join(fake, "claude"), FAKE_CLAUDE);
    await chmod(join(fake, "claude"), 0o755);

    // An allowlisted host: a server on this machine, reached by the proxy as host.docker.internal.
    const server = createServer((_req, res) => res.end("allowed-ok"));
    await new Promise<void>((r) =>
      server.listen(0, platform() === "linux" ? "0.0.0.0" : "127.0.0.1", r),
    );
    cleanups.push(() => new Promise((r) => server.close(() => r())));
    const port = (server.address() as AddressInfo).port;

    const containersDir = join(root, "containers");
    const runsDir = join(root, "runs");
    const runner = createContainerRunner({
      checkouts: [join(root, "projects")],
      resolveRepoPath: () => {
        throw new Error("the checkout should have been found");
      },
      worktreesDir: join(root, "worktrees"),
      runsDir,
      startPoint: () => "main",
      pollMs: 100,
      screenLogMs: 0,
      startTimeoutMs: 60_000,
      tmux: { socket: SOCKET },
      container: {
        containersDir,
        claudeBin: join(fake, "claude"),
        extraMounts: [{ source: fake, target: fake, readOnly: true }],
        allowedHosts: [`host.docker.internal:${port}`],
        proxyAddHosts: ["host.docker.internal:host-gateway"],
        // The stand-in upstream is on the host: only the runner's own tests may say so.
        proxyPrivateOk: [`host.docker.internal:${port}`],
        modelCredential: () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }),
        // `ps` shows `<node> <script> <args>` for the stand-in script: drop the interpreter.
        readCommand: (rt, name) => {
          const read = containerReadCommand(rt, name);
          return async (pid) => (await read(pid))?.replace(/^\S+\s+/, "") ?? null;
        },
      },
    });
    const job: Job = {
      jobId: "job_ctr1",
      runId: "run_1",
      runNo: 1,
      stage: "build",
      workItem: { id: "wi_1", number: 7, title: "Add a line" },
      repo: { url: "https://github.com/acme/app.git", owner: "acme", name: "app", baseRef: "main" },
      branch: "factory/7-add-a-line-run-1",
      harness: {
        id: "claude-code",
        role: "implement",
        prompt: JSON.stringify({
          token: TOKEN,
          hostHome: homedir(),
          sentinel,
          allowedUrl: `http://host.docker.internal:${port}/`,
        }),
      },
      context: {},
      requires: [],
      limits: { sessionTimeoutMs: 120_000 },
      lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    };
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    cleanups.push(() => runner.release(job, ws, undefined).catch(() => {}));
    const session = await runner.startSession(job, ws, signal);
    expect(session.takeover?.hint).toBe(`tmux -L ${SOCKET} attach -t sf-job_ctr1`);
    expect(existsSync(join(containersDir, ".secrets", "sf-job_ctr1.env"))).toBe(false);

    // A person types into the live session (what `tmux attach` does): it reaches the agent.
    const steered = (async () => {
      for (let i = 0; i < 600 && !existsSync(join(ws.path, RESULT_FILE)); i++) await sleep(100);
      await sleep(300);
      await runner.steer?.(session, "also say thanks");
    })();
    const events: AdapterEvent[] = [];
    for await (const e of runner.events(job, session, signal)) events.push(e);
    await steered;
    const r = JSON.parse(await readFile(join(ws.path, RESULT_FILE), "utf8"));
    expect(events.at(-1), JSON.stringify(r, null, 2)).toMatchObject({
      type: "session.ended",
      outcome: "completed",
    });
    expect(events.some((e) => e.type === "tool" && e.name === "Bash")).toBe(true);

    // The credential reached Claude; the host home and the file next to the job did not.
    expect(r.token).toBe(true);
    expect(r.home).toBe(join(containersDir, "sf-job_ctr1", "home"));
    expect(r.hostHome).toBe(false);
    expect(r.sentinel).toBe("ENOENT");
    expect(r.root).not.toContain("Users");
    // Writes: only the working tree, the home and /tmp.
    for (const [path, outcome] of Object.entries(r.mustFail)) {
      expect(outcome, path).toMatch(/^(EROFS|EACCES|EBUSY|EPERM)$/);
    }
    for (const [path, outcome] of Object.entries(r.mayWrite)) expect(outcome, path).toBe("written");
    // Egress: the allowlisted host through the proxy, 403 or blocked for the rest, no way around.
    expect(r.allowed).toBe("200 allowed-ok");
    expect([403, "blocked"]).toContain(r.deniedHttp);
    expect(r.deniedCurl).toBe("403");
    expect(r.allowedCurl).toBe("allowed-ok");
    expect(r.deniedHttps).toBe("blocked");
    expect(r.direct).toMatch(/ENETUNREACH|EHOSTUNREACH|timeout|ECONNREFUSED/);
    expect(r.dns).toMatch(/ENOTFOUND|EAI_AGAIN|ESERVFAIL|EREFUSED/);
    expect(await readFile(join(ws.path, "steered.txt"), "utf8")).toBe("also say thanks");

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
    expect(git(seed, "for-each-ref", "--format=%(refname)", "refs/software-factory")).toBe("");

    const artifacts = await runner.collectArtifacts(job, ws, session);
    const egress = artifacts.find((a) => a.kind === "log" && a.name === "egress-log");
    expect(egress && "text" in egress ? egress.text : "").toMatch(
      /"host":"example.com"[^}]*"allowed":false/,
    );
    expect(egress && "text" in egress ? egress.text : "").toMatch(
      /"host":"host.docker.internal"[^}]*"allowed":true/,
    );

    await runner.release(job, ws, session);
    await runner.release(job, ws, session);
    expect(
      await runtime
        .containers(JOB_LABEL)
        .then((cs) => cs.filter((c) => c.labels[JOB_LABEL] === "job_ctr1")),
    ).toEqual([]);
    expect(
      await runtime
        .networks(JOB_LABEL)
        .then((ns) => ns.filter((n) => n.labels[JOB_LABEL] === "job_ctr1")),
    ).toEqual([]);
    expect(existsSync(join(containersDir, "sf-job_ctr1"))).toBe(false);
    expect(existsSync(join(runsDir, "job_ctr1"))).toBe(false);
    expect(await tmuxCli({ socket: SOCKET }).paneState("sf-job_ctr1")).toBeNull();
  });
});
