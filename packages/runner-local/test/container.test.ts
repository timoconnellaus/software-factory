// A container per job (ADR 0430) against a scripted `docker` and tmux (src/testing.ts) over real
// git: the job repo, the container spec and its check, the egress allowlist and proxy, the session
// end (git dir check, credential scan), release and reaping.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HarnessAccount,
  PROMPT_FILE,
  readLaunchRecord,
  STATUS_FILE,
} from "@software-factory/harness-claude";
import { type AdapterEvent, type Job, RESULT_FILE } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
// The proxy is a plain script copied into the image; its rule must match the module's.
import { createEgressProxy, hostAllowed as proxyHostAllowed } from "../container/egress-proxy.mjs";
import {
  CONTAINER_RECORD,
  type ContainerRecord,
  checkJobGitDir,
  containerProblems,
  createContainerRunner,
  createJobRepo,
  credentialForAccount,
  credentialFrom,
  dockerRunArgs,
  dockerRuntime,
  egressAllowlist,
  HarnessConfigMismatch,
  hostAllowed,
  JOB_LABEL,
  ROLE_LABEL,
  reapCheckContainers,
  reapContainers,
  scanForSecrets,
} from "../src/index.ts";
import {
  inspectFromSpec,
  type ScriptedTmuxOptions,
  scriptedDocker,
  scriptedTmux,
} from "../src/testing.ts";

const URL = "https://github.com/acme/app.git";
const TOKEN = "sk-ant-oat01-THE-OWNERS-TOKEN-0123456789abcdef";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qm", message);

const cleanups: (() => Promise<void>)[] = [];
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
    repo: {
      url: URL,
      owner: "acme",
      name: "app",
      baseRef: "factory/7-add-a-line",
      defaultBranch: "main",
    },
    branch: "factory/7-add-a-line-run-1",
    harness: { id: "claude-code", role: "implement", prompt: "add a line" },
    context: {},
    requires: [],
    limits: { sessionTimeoutMs: 10_000 },
    lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
    ...overrides,
  };
}

/** "GitHub", the owner's checkout of it (with other work), and a container runner on fakes. */
async function world(
  options: {
    tmux?: ScriptedTmuxOptions;
    docker?: Partial<Parameters<typeof scriptedDocker>[0]>;
    credential?: string | null;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sf-ctr-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  await mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "# scratch\n");
  git(seed, "add", ".");
  commit(seed, "init");
  git(seed, "branch", "factory/7-add-a-line");
  const bare = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", seed, bare);
  const projects = join(root, "projects");
  const owner = join(projects, "app");
  await mkdir(projects);
  git(root, "clone", "-q", bare, owner);
  git(owner, "remote", "set-url", "origin", URL);
  // The owner's own work: a private branch with a commit, uncommitted files, a .env.
  git(owner, "checkout", "-q", "-b", "owner-secret-branch");
  await writeFile(join(owner, "PRIVATE.md"), "the owner's unpublished work\n");
  git(owner, "add", "PRIVATE.md");
  commit(owner, "private");
  const privateSha = git(owner, "rev-parse", "HEAD");
  await writeFile(join(owner, ".env"), "OWNER_SECRET=1\n");
  // The host's fetched refs (runner-host's ensureRepo does this).
  git(owner, "fetch", "-q", bare, "+refs/heads/*:refs/software-factory/heads/*");
  const startSha = git(owner, "rev-parse", "refs/software-factory/heads/factory/7-add-a-line");

  const tmux = scriptedTmux(options.tmux);
  const docker = scriptedDocker({ base: tmux.exec, ...options.docker });
  const runsDir = join(root, "state", "runs");
  const containersDir = join(root, "data", "containers");
  const credential = options.credential === undefined ? TOKEN : options.credential;
  const runner = createContainerRunner({
    exec: docker.exec,
    checkouts: [projects],
    resolveRepoPath: () => {
      throw new Error("the owner's checkout should have been found");
    },
    worktreesDir: join(root, "data", "worktrees"),
    runsDir,
    startPoint: () => startSha,
    pollMs: 2,
    screenLogMs: 0,
    container: {
      containersDir,
      user: "501:20",
      modelCredential: () => (credential ? { env: { CLAUDE_CODE_OAUTH_TOKEN: credential } } : null),
    },
  });
  return { root, bare, owner, privateSha, startSha, tmux, docker, runner, runsDir, containersDir };
}

const ownerState = (owner: string) => ({
  head: git(owner, "rev-parse", "HEAD"),
  branch: git(owner, "branch", "--show-current"),
  branches: git(owner, "branch", "--list"),
  status: git(owner, "status", "--porcelain"),
  worktrees: git(owner, "worktree", "list"),
  refs: git(owner, "for-each-ref", "--format=%(refname)"),
  config: execFileSync("cat", [join(owner, ".git", "config")], { encoding: "utf8" }),
});

async function drain(it: AsyncIterable<AdapterEvent>) {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const signal = () => new AbortController().signal;

describe("the job repo (ADR 0430 §3)", () => {
  it("holds only the start point's history and the default branch, and leaves the checkout alone", async () => {
    const w = await world();
    const before = ownerState(w.owner);
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    expect(ws.path.startsWith(w.containersDir)).toBe(true);
    expect(ws.baseSha).toBe(w.startSha);
    expect(git(ws.path, "branch", "--show-current")).toBe(j.branch);
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    // Its own git dir, not the checkout's.
    const gitDir = git(ws.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(gitDir).toBe(join(w.containersDir, "sf-job_1", "git"));
    // None of the owner's other work: no private branch, no private object, no .env, no WIP.
    expect(git(ws.path, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(
      [
        `refs/heads/${j.branch}`,
        "refs/software-factory/heads/factory/7-add-a-line",
        "refs/software-factory/heads/main",
      ].sort(),
    );
    expect(() => git(ws.path, "cat-file", "-e", `${w.privateSha}^{commit}`)).toThrow();
    expect(existsSync(join(ws.path, ".env"))).toBe(false);
    expect(existsSync(join(ws.path, "PRIVATE.md"))).toBe(false);
    // The checkout: unchanged, and the temporary ref is gone.
    expect(ownerState(w.owner)).toEqual(before);
    await w.runner.release(j, ws, undefined);
    expect(existsSync(join(w.containersDir, "sf-job_1"))).toBe(false);
  });

  it("repairs a tampered git dir and reports it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-repo-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const checkout = join(root, "c");
    await mkdir(checkout);
    git(checkout, "init", "-q", "-b", "main");
    await writeFile(join(checkout, "a"), "a\n");
    git(checkout, "add", ".");
    commit(checkout, "a");
    const repo = await createJobRepo({
      exec: (await import("../src/exec.ts")).nodeExec,
      checkout,
      work: join(root, "work"),
      gitDir: join(root, "git"),
      jobId: "job_x",
      branch: "factory/1-x-run-1",
      start: "main",
    });
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
    const problems = await checkJobGitDir(repo);
    expect(problems.join("\n")).toMatch(/\.git was changed/);
    expect(problems.join("\n")).toMatch(/commondir/);
    expect(problems.join("\n")).toMatch(/alternates/);
    expect(problems.join("\n")).toMatch(/config was changed/);
    expect(problems.join("\n")).toMatch(/hooks were changed/);
    expect(problems.join("\n")).toMatch(/symlink: refs\/tags/);
    // Put back: the host's git works on it again, with the factory's config.
    expect(await checkJobGitDir(repo)).toEqual([]);
    expect(git(repo.work, "config", "--get", "core.fsmonitor")).toBe("false");
    expect(git(repo.work, "rev-parse", "HEAD")).toBe(repo.baseSha);
  });

  it("finds the credential in new commits and in untracked files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-scan-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const { nodeExec } = await import("../src/exec.ts");
    const work = join(root, "w");
    await mkdir(work);
    git(work, "init", "-q", "-b", "main");
    await writeFile(join(work, "a"), "a\n");
    git(work, "add", ".");
    commit(work, "a");
    const base = git(work, "rev-parse", "HEAD");
    expect(await scanForSecrets(nodeExec, work, base, [TOKEN])).toEqual([]);
    await writeFile(join(work, "notes.txt"), `here it is: ${TOKEN}\n`);
    expect(await scanForSecrets(nodeExec, work, base, [TOKEN])).toEqual(["notes.txt"]);
    git(work, "add", ".");
    commit(work, "leak");
    await writeFile(join(work, "notes.txt"), "gone now\n");
    git(work, "add", ".");
    commit(work, "hide it");
    // Removed from the tree, still in the history that would be pushed.
    expect((await scanForSecrets(nodeExec, work, base, [TOKEN])).join()).toMatch(/commits since/);
  });
});

describe("the container spec (ADR 0430 §4, §7)", () => {
  it("mounts only the job's dirs, drops privileges and names the job network", async () => {
    const w = await world();
    const ws = await w.runner.prepareWorkspace(job(), signal());
    const record = JSON.parse(
      await readFile(join(w.runsDir, "job_1", CONTAINER_RECORD), "utf8"),
    ) as ContainerRecord;
    const args = dockerRunArgs(record.agent);
    for (const flag of ["--read-only", "--init", "-i", "-t"]) expect(args).toContain(flag);
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--security-opt no-new-privileges");
    expect(args.join(" ")).toContain("--network sf-job_1-net");
    expect(args.join(" ")).toContain("--user 501:20");
    expect(args.join(" ")).not.toMatch(/--privileged|docker\.sock|-p |--publish/);
    const job1 = join(w.containersDir, "sf-job_1");
    const runDir = join(w.runsDir, "job_1");
    const mounts = record.agent.mounts.map((m) => `${m.source}${m.readOnly ? " ro" : ""}`);
    expect(mounts.sort()).toEqual(
      [
        `${job1}/work`,
        `${job1}/work/.git ro`,
        `${job1}/work/.claude ro`,
        `${job1}/git`,
        `${job1}/git/config ro`,
        `${job1}/git/hooks ro`,
        `${job1}/git/info ro`,
        `${job1}/git/objects/info ro`,
        `${runDir} ro`,
        `${runDir}/${STATUS_FILE}`,
        `${runDir}/claude.pid`,
        `${job1}/home`,
        `${job1}/tmp`,
        `${job1}/pnpm-store`,
        `${join(w.root, "state", "attachments", "job_1")} ro`,
      ].sort(),
    );
    // Same paths inside and out; nothing of the host home or the owner's checkout.
    for (const m of record.agent.mounts) {
      expect(m.target).toBe(m.source);
      expect(m.source.startsWith(w.owner)).toBe(false);
    }
    expect(record.agent.env.HOME).toBe(`${job1}/home`);
    expect(record.agent.env.HTTPS_PROXY).toBe("http://egress:3128");
    // The credential is never in the argv or the script.
    const script = await readFile(join(runDir, "container.sh"), "utf8");
    expect(script).toContain("docker run");
    expect(script).not.toContain(TOKEN);
    expect(record.allow).toEqual(egressAllowlist(undefined));
    expect(record.proxy.command).toContain(record.allow.join(","));
    await w.runner.release(job(), ws, undefined);
  });

  it("finds every difference between a running container and its spec", async () => {
    const w = await world();
    const ws = await w.runner.prepareWorkspace(job(), signal());
    const record = JSON.parse(
      await readFile(join(w.runsDir, "job_1", CONTAINER_RECORD), "utf8"),
    ) as ContainerRecord;
    const spec = record.agent;
    expect(containerProblems(spec, inspectFromSpec(spec))).toEqual([]);
    const cases: Array<[string, (i: ReturnType<typeof inspectFromSpec>) => void]> = [
      ["image", (i) => (i.Image = "sha256:other")],
      ["privileged", (i) => ((i.HostConfig ?? {}).Privileged = true)],
      ["root filesystem", (i) => ((i.HostConfig ?? {}).ReadonlyRootfs = false)],
      ["capabilities added", (i) => ((i.HostConfig ?? {}).CapAdd = ["SYS_ADMIN"])],
      ["network", (i) => ((i.HostConfig ?? {}).NetworkMode = "bridge")],
      [
        "on networks",
        (i) => ((i.NetworkSettings ?? {}).Networks = { bridge: {}, [spec.network]: {} }),
      ],
      ["ports", (i) => ((i.HostConfig ?? {}).PortBindings = { "22/tcp": [{}] })],
      [
        "mounts differ",
        (i) => i.HostConfig?.Mounts?.push({ Type: "bind", Source: "/Users/x", Target: "/Users/x" }),
      ],
      [
        "mounts differ",
        (i) => {
          for (const m of i.HostConfig?.Mounts ?? []) delete m.ReadOnly;
        },
      ],
      ["user", (i) => ((i.Config ?? {}).User = "0:0")],
      ["command", (i) => ((i.Config ?? {}).Cmd = ["/bin/sh", "-c", "evil"])],
      ["host's pid", (i) => ((i.HostConfig ?? {}).PidMode = "host")],
      ["environment", (i) => ((i.Config ?? {}).Env = [])],
    ];
    for (const [want, change] of cases) {
      const inspect = inspectFromSpec(spec);
      change(inspect);
      expect(containerProblems(spec, inspect).join("\n"), want).toMatch(new RegExp(want));
    }
    expect(containerProblems(spec, null)).toEqual([`container ${spec.name} isn't running`]);
    await w.runner.release(job(), ws, undefined);
  });
});

describe("egress (ADR 0430 §5)", () => {
  const cases: Array<[string, number, string[], boolean]> = [
    ["registry.npmjs.org", 443, ["registry.npmjs.org"], true],
    ["registry.npmjs.org", 80, ["registry.npmjs.org"], true],
    ["registry.npmjs.org", 22, ["registry.npmjs.org"], false],
    ["evil.npmjs.org", 443, ["registry.npmjs.org"], false],
    ["api.github.com", 443, ["*.github.com"], true],
    ["github.com", 443, ["*.github.com"], false],
    ["xgithub.com", 443, ["*.github.com"], false],
    ["HOST.example", 8080, ["host.example:8080"], true],
    ["host.example", 443, ["host.example:8080"], false],
    ["example.com.", 443, ["example.com"], true],
    ["127.0.0.1", 443, ["api.anthropic.com"], false],
  ];
  it("allows exact names, *.suffix subdomains and named ports, the same in the module and the proxy", () => {
    for (const [host, port, allow, want] of cases) {
      expect(hostAllowed(host, port, allow), `${host}:${port}`).toBe(want);
      expect(proxyHostAllowed(host, port, allow), `proxy ${host}:${port}`).toBe(want);
    }
  });

  it("is the stage's hosts plus the model API and the runner's extras", () => {
    const allow = egressAllowlist({ allowedDomains: ["*.example.com"] }, ["extra.example"]);
    expect(allow).toEqual(
      expect.arrayContaining([
        "registry.npmjs.org",
        "github.com",
        "api.anthropic.com",
        "*.example.com",
        "extra.example",
      ]),
    );
  });

  it("the proxy forwards allowed hosts and refuses the rest with 403", async () => {
    const upstream = createHttpServer((_req, res) => res.end("upstream-ok"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const tcp = createServer((s) => s.end("tcp-ok"));
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    const up = (upstream.address() as AddressInfo).port;
    const tp = (tcp.address() as AddressInfo).port;
    const lines: Array<{ host: string; allowed: boolean }> = [];
    const proxy = createEgressProxy({
      allow: [`127.0.0.1:${up}`, `127.0.0.1:${tp}`],
      log: (l: { host: string; allowed: boolean }) => lines.push(l),
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const pp = (proxy.address() as AddressInfo).port;
    cleanups.push(async () => {
      for (const s of [upstream, tcp, proxy]) await new Promise((r) => s.close(r));
    });
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: pp, path: url, method: "GET" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        r.on("error", reject);
        r.end();
      });
    expect(await get(`http://127.0.0.1:${up}/x`)).toEqual({ status: 200, body: "upstream-ok" });
    expect((await get(`http://localhost:${up}/x`)).status).toBe(403);
    expect((await get("http://example.com/")).status).toBe(403);
    const tunnel = (target: string) =>
      new Promise<string>((resolve) => {
        const s = connect(pp, "127.0.0.1", () =>
          s.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`),
        );
        let text = "";
        s.on("data", (c) => (text += c));
        s.on("close", () => resolve(text));
        s.on("error", () => resolve(text));
      });
    expect(await tunnel(`127.0.0.1:${tp}`)).toMatch(/^HTTP\/1.1 200[\s\S]*tcp-ok$/);
    expect(await tunnel("example.com:443")).toMatch(/^HTTP\/1.1 403/);
    expect(lines.map((l) => `${l.host} ${l.allowed}`)).toEqual([
      "127.0.0.1 true",
      "localhost false",
      "example.com false",
      "127.0.0.1 true",
      "example.com false",
    ]);
  });
});

describe("a container job's session", { timeout: 30_000 }, () => {
  it("runs end to end: proxy, agent, verified launch, the agent's commit, release twice", async () => {
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
    const before = ownerState(w.owner);
    const j = job();
    expect((await w.runner.manifest()).capabilities).toContain("container-isolation");
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    expect(session.takeover?.hint).toBe("tmux -L software-factory attach -t sf-job_1");
    // The proxy on the internal network, the agent with its credential from a file that's gone.
    expect(w.docker.networks.get("sf-job_1-net")?.internal).toBe(true);
    expect(
      w.docker.calls.some((c) => c[0] === "network" && c[1] === "connect" && c.includes("egress")),
    ).toBe(true);
    expect(w.docker.containers.has("sf-job_1")).toBe(true);
    expect(w.docker.containers.has("sf-job_1-egress")).toBe(true);
    expect(w.docker.envFileOf("sf-job_1")).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
    expect(existsSync(join(w.containersDir, ".secrets", "sf-job_1.env"))).toBe(false);
    // The launch was checked inside the container before the prompt went in.
    expect(
      w.docker.calls.some((c) => c[0] === "exec" && c[1] === "sf-job_1" && c[2] === "ps"),
    ).toBe(true);
    expect(await readFile(join(ws.path, PROMPT_FILE), "utf8")).toBe("add a line");
    const seed = JSON.parse(
      await readFile(join(w.containersDir, "sf-job_1", "home", ".claude.json"), "utf8"),
    );
    expect(seed.projects[ws.path].hasTrustDialogAccepted).toBe(true);

    const events = await drain(w.runner.events(j, session, signal()));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });
    // Stopped before the host's git runs on the repo.
    expect(w.docker.containers.size).toBe(0);
    expect(w.docker.networks.size).toBe(0);
    // The agent's commit is in the job repo, on the run branch, for the host to push.
    expect(git(ws.path, "log", "-1", "--format=%s")).toBe("add");
    expect(git(ws.path, "rev-parse", `${j.branch}^`)).toBe(w.startSha);
    const artifacts = await w.runner.collectArtifacts(j, ws, session);
    expect(artifacts.find((a) => a.kind === "log" && a.name === "egress-log")).toBeTruthy();

    await w.runner.release(j, ws, session);
    await w.runner.release(j, ws, session);
    expect(existsSync(join(w.containersDir, "sf-job_1"))).toBe(false);
    expect(existsSync(join(w.runsDir, "job_1"))).toBe(false);
    expect(w.tmux.sessions.size).toBe(0);
    expect(ownerState(w.owner)).toEqual(before);
  });

  it("kills a container that isn't what the runner started, before the prompt", async () => {
    const w = await world({
      docker: {
        tamper: (name, inspect) => {
          if (name === "sf-job_1") (inspect.HostConfig ?? {}).Privileged = true;
        },
      },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const err = await w.runner.startSession(j, ws, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessConfigMismatch);
    expect(String(err.message)).toMatch(/harness-config-mismatch: .*privileged/);
    expect(existsSync(join(ws.path, PROMPT_FILE))).toBe(false);
    expect(w.docker.containers.size).toBe(0);
    expect(w.tmux.sessions.size).toBe(0);
    await w.runner.release(j, ws, undefined);
  });

  it("kills a process inside the container that doesn't match its launch record", async () => {
    const w = await world({
      docker: {
        ps: (record) => record.argv.join(" ").replace("bypassPermissions", "auto"),
      },
    });
    const j = job({ stage: "triage" });
    const ws = await w.runner.prepareWorkspace(j, signal());
    expect((await readLaunchRecord(ws.runDir))?.mode).toBe("bypassPermissions");
    const err = await w.runner.startSession(j, ws, signal()).catch((e) => e);
    expect(String(err.message)).toMatch(/permission mode auto, expected bypassPermissions/);
    expect(w.docker.containers.size).toBe(0);
    await w.runner.release(j, ws, undefined);
  });

  it("fails without a credential, before starting anything", async () => {
    const w = await world({ credential: null });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    await expect(w.runner.startSession(j, ws, signal())).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(w.docker.containers.size).toBe(0);
    await w.runner.release(j, ws, undefined);
  });

  it("fails a session that tampered with its git dir, after putting it back", async () => {
    const w = await world({
      tmux: {
        onPrompt: async (s, append) => {
          const gitDir = join(s.cwd, "..", "git");
          await writeFile(join(gitDir, "commondir"), "/tmp/elsewhere\n");
          append({ event: "Stop" });
        },
      },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    const ended = (await drain(w.runner.events(j, session, signal()))).at(-1);
    expect(ended).toMatchObject({ type: "session.ended", outcome: "failed" });
    expect(JSON.stringify(ended)).toMatch(/Not pushing: the session created commondir/);
    expect(existsSync(join(w.containersDir, "sf-job_1", "git", "commondir"))).toBe(false);
    await w.runner.release(j, ws, session);
  });

  it("fails a session that wrote the credential into the repo", async () => {
    const w = await world({
      tmux: {
        onPrompt: (s, append) => {
          execFileSync("sh", ["-c", `echo "${TOKEN}" > leak.txt`], { cwd: s.cwd });
          git(s.cwd, "add", "leak.txt");
          git(s.cwd, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qm", "oops");
          append({ event: "Stop" });
        },
      },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    const ended = (await drain(w.runner.events(j, session, signal()))).at(-1);
    expect(ended).toMatchObject({ type: "session.ended", outcome: "failed" });
    expect(JSON.stringify(ended)).toMatch(/model credential is in/);
    expect(JSON.stringify(ended)).not.toContain(TOKEN);
    await w.runner.release(j, ws, session);
  });

  it("runs a planning job on the host, as runner-local does", async () => {
    const w = await world();
    const j = job({
      stage: "planning",
      planning: {
        sessionId: "ps_1",
        sessionRef: "00000000-0000-4000-8000-000000000001",
        resume: false,
      },
    } as Partial<Job>);
    const ws = await w.runner.prepareWorkspace(j, signal(), {
      planningRelay: { url: "http://127.0.0.1:1", token: "t" },
    });
    expect(ws.path.startsWith(w.containersDir)).toBe(false);
    expect("container" in ws).toBe(false);
    await w.runner.release(j, ws, undefined);
  });
});

describe("reaping container jobs", () => {
  it("removes the containers, networks and dirs of jobs the host no longer runs", async () => {
    const w = await world();
    const ws = await w.runner.prepareWorkspace(job(), signal());
    await w.runner.startSession(job(), ws, signal());
    const runtime = dockerRuntime({ exec: w.docker.exec });
    expect(
      await reapContainers(
        { containersDir: w.containersDir, runsDir: w.runsDir, runtime },
        new Set(["job_1"]),
      ),
    ).toEqual([]);
    expect(w.docker.containers.size).toBe(2);
    expect(
      await reapContainers(
        { containersDir: w.containersDir, runsDir: w.runsDir, runtime },
        new Set(),
      ),
    ).toEqual(["job_1"]);
    expect(w.docker.containers.size).toBe(0);
    expect(w.docker.networks.size).toBe(0);
    expect(existsSync(join(w.containersDir, "sf-job_1"))).toBe(false);
    expect(existsSync(join(w.runsDir, "job_1"))).toBe(false);
  });
});

describe("reaping a sandbox runner's check containers (fifth review)", () => {
  it("removes check and egress containers and check networks of jobs not running, and nothing else", async () => {
    const docker = scriptedDocker({ base: scriptedTmux().exec });
    const runtime = dockerRuntime({ exec: docker.exec });
    const label = (jobId: string, role: string) => ({ [JOB_LABEL]: jobId, [ROLE_LABEL]: role });
    const spec = (name: string, labels: Record<string, string>) => ({
      name,
      image: "img",
      user: "1000:1000",
      workdir: "/",
      entrypoint: "/bin/sh",
      command: [],
      env: {},
      mounts: [],
      tmpfs: {},
      network: "none",
      labels,
      pidsLimit: 1,
      interactive: false,
    });
    await runtime.createNetwork("sf-chk-0123456789ab-net", {
      internal: true,
      labels: label("job_dead", "check"),
    });
    await runtime.createNetwork("sf-chk-ba9876543210-net", {
      internal: true,
      labels: { [JOB_LABEL]: "job_old" }, // before the role label: known by its name
    });
    await runtime.createNetwork("sf-job_live", {
      internal: true,
      labels: label("job_live", "check"),
    });
    await runtime.start(spec("sf-chk-0123456789ab", label("job_dead", "check")));
    await runtime.start(spec("sf-chk-0123456789ab-egress", label("job_dead", "egress")));
    await runtime.start(spec("sf-chk-live", label("job_live", "check")));
    await runtime.start(spec("sf-agent", label("job_dead", "agent")));
    await runtime.start(spec("unlabelled", {}));
    expect((await reapCheckContainers(runtime, new Set(["job_live"]))).sort()).toEqual([
      "job_dead",
      "job_old",
    ]);
    expect([...docker.containers.keys()].sort()).toEqual(["sf-agent", "sf-chk-live", "unlabelled"]);
    expect([...docker.networks.keys()]).toEqual(["sf-job_live"]);
  });
});

describe("the credential", () => {
  it("comes from runner.json's container env, else the host's, OAuth token first", () => {
    expect(credentialFrom({ ANTHROPIC_API_KEY: "k" }, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).toEqual({
      env: { ANTHROPIC_API_KEY: "k" },
    });
    expect(
      credentialFrom(undefined, { CLAUDE_CODE_OAUTH_TOKEN: " t ", ANTHROPIC_API_KEY: "k" }),
    ).toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
    });
    expect(credentialFrom({}, { HOME: "/x" })).toBeNull();
  });
});

describe("the job's Claude account in a container (ADR 0410, 0430)", () => {
  it("gives a token account's token, refuses a login account, falls back for default", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-acct-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "work.token");
    await writeFile(file, `${TOKEN}\n`, { mode: 0o600 });
    const token = {
      name: "work",
      configDir: join(root, "cfg"),
      token: { file, env: "CLAUDE_CODE_OAUTH_TOKEN" as const },
    };
    expect(await credentialForAccount(token)).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    await expect(credentialForAccount({ name: "me", configDir: join(root, "me") })).rejects.toThrow(
      /login, and container isolation needs a token account/,
    );
    const fallback = () => ({ env: { ANTHROPIC_API_KEY: "k" } });
    expect(await credentialForAccount({ name: "default" }, fallback)).toEqual(fallback());
    expect(await credentialForAccount({ name: "default" })).toBeNull();
  });

  it("puts the active token account's token in the container; refuses a login account up front", async () => {
    const w = await world();
    const file = join(w.root, "work.token");
    const workToken = "sk-ant-oat01-the-work-account-token-0123456789";
    await writeFile(file, `${workToken}\n`, { mode: 0o600 });
    let account: HarnessAccount = {
      name: "work",
      configDir: join(w.root, "accounts", "work"),
      token: { file, env: "CLAUDE_CODE_OAUTH_TOKEN" },
    };
    const runner = createContainerRunner({
      exec: w.docker.exec,
      checkouts: [join(w.root, "projects")],
      resolveRepoPath: () => {
        throw new Error("unexpected");
      },
      worktreesDir: join(w.root, "data", "worktrees"),
      runsDir: w.runsDir,
      startPoint: () => w.startSha,
      pollMs: 2,
      account: () => account,
      container: { containersDir: w.containersDir, user: "501:20" },
    });
    const j = job();
    const ws = await runner.prepareWorkspace(j, signal());
    // The transcript is in the container's own home, not the account's config dir on the host.
    expect(ws.account).toEqual({
      name: "work",
      configDir: join(w.containersDir, "sf-job_1", "home", ".claude"),
    });
    await runner.startSession(j, ws, signal());
    expect(w.docker.envFileOf("sf-job_1")).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${workToken}\n`);
    // Neither the account's config dir nor its token file is mounted.
    const record = JSON.parse(
      await readFile(join(w.runsDir, "job_1", CONTAINER_RECORD), "utf8"),
    ) as ContainerRecord;
    const accounts = join(w.root, "accounts");
    expect(
      record.agent.mounts.some((m) => m.source.startsWith(accounts) || m.source === file),
    ).toBe(false);
    await runner.release(j, ws, undefined);

    account = { name: "me", configDir: join(w.root, "accounts", "me") };
    const runs = w.docker.calls.filter((c) => c[0] === "run").length;
    await expect(runner.prepareWorkspace(j, signal())).rejects.toThrow(/needs a token account/);
    expect(existsSync(join(w.containersDir, "sf-job_1"))).toBe(false);
    expect(w.docker.calls.filter((c) => c[0] === "run")).toHaveLength(runs);
  });
});
