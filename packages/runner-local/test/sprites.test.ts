// A sprite per job (ADR 0480) against a fake Sprites API on localhost (src/sprites/fake.ts): its
// HTTP endpoints and exec WebSocket, with the runner's fixed scripts run for real in a directory per
// sprite, and real git. The job's tmux pane is scripted, but it runs the real bridge in-process, so
// typed keys go over the TTY WebSocket to a stand-in Claude in the sprite.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PROMPT_FILE, PROMPT_POINTER } from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  isReleaseIncomplete,
  type Job,
  RESULT_FILE,
} from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSpritesRunner,
  egressProblems,
  egressRules,
  execUrl,
  HarnessConfigMismatch,
  parseEgressRules,
  parsePull,
  pinnedClaudeVersion,
  reapSprites,
  SPRITE_RECORD,
  spriteName,
  spritePrefix,
  spritesApi,
} from "../src/index.ts";
import {
  bridgeSpawn,
  type FakeAgent,
  type FakeClaudeOptions,
  type FakeSpritesOptions,
  fakeClaude,
  fakeSpritesApi,
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
  for (const c of cleanups.splice(0).reverse()) await c();
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

async function world(
  options: {
    claude?: FakeClaudeOptions;
    api?: FakeSpritesOptions;
    credential?: string | null;
    token?: string | null;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sf-spr-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  await mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "# scratch\n");
  await writeFile(join(seed, ".gitignore"), "node_modules/\n");
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
  git(owner, "checkout", "-q", "-b", "owner-secret-branch");
  await writeFile(join(owner, "PRIVATE.md"), "the owner's unpublished work\n");
  git(owner, "add", "PRIVATE.md");
  commit(owner, "private");
  git(owner, "fetch", "-q", bare, "+refs/heads/*:refs/software-factory/heads/*");
  const startSha = git(owner, "rev-parse", "refs/software-factory/heads/factory/7-add-a-line");

  const credentials: string[] = [];
  const api = await fakeSpritesApi(join(root, "cloud"), {
    onTty: fakeClaude({ credentials, ...options.claude }),
    ...options.api,
  });
  cleanups.push(api.close);
  const tokenFile = join(root, "config", "sprites.token");
  await mkdir(join(root, "config"), { recursive: true });
  if (options.token !== null)
    await writeFile(tokenFile, `${options.token ?? api.token}\n`, { mode: 0o600 });
  const tmux = scriptedTmux({ spawn: bridgeSpawn() });
  const runsDir = join(root, "state", "runs");
  const spritesDir = join(root, "data", "sprites");
  const credential = options.credential === undefined ? TOKEN : options.credential;
  const runner = createSpritesRunner({
    exec: tmux.exec,
    checkouts: [projects],
    resolveRepoPath: () => {
      throw new Error("the owner's checkout should have been found");
    },
    worktreesDir: join(root, "data", "worktrees"),
    runsDir,
    startPoint: () => startSha,
    pollMs: 5,
    screenLogMs: 0,
    sprites: {
      apiUrl: api.url,
      tokenFile,
      spritesDir,
      namePrefix: "sf-test-",
      mirrorMs: 5,
      modelCredential: () => (credential ? { env: { CLAUDE_CODE_OAUTH_TOKEN: credential } } : null),
    },
  });
  return {
    root,
    bare,
    owner,
    startSha,
    api,
    tmux,
    runner,
    runsDir,
    spritesDir,
    credentials,
    tokenFile,
  };
}

const ownerState = (owner: string) => ({
  head: git(owner, "rev-parse", "HEAD"),
  branches: git(owner, "branch", "--list"),
  status: git(owner, "status", "--porcelain"),
  worktrees: git(owner, "worktree", "list"),
  refs: git(owner, "for-each-ref", "--format=%(refname)"),
});

async function drain(it: AsyncIterable<AdapterEvent>) {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const signal = () => new AbortController().signal;

/** The agent's work in the sprite: a commit, an uncommitted edit, an untracked file, an ignored dir. */
const builds = (agent: FakeAgent) => {
  execFileSync("sh", ["-c", "echo hello >> README.md"], { cwd: agent.work });
  agent.git("commit", "-qam", "add a line");
  execFileSync(
    "sh",
    [
      "-c",
      "echo more >> README.md; echo new > NEW.md; mkdir -p node_modules/x; echo junk > node_modules/x/i.js",
    ],
    { cwd: agent.work },
  );
  execFileSync("sh", ["-c", `echo '{"notes":"ok"}' > ${RESULT_FILE}`], { cwd: agent.work });
  agent.append({ event: "PreToolUse", tool: "Bash", input: '{"command":"git commit"}' });
  agent.append({ event: "Stop" });
};

describe("the Sprites API client (ADR 0480)", () => {
  it("creates, lists by prefix, sets egress, execs with stdin and destroys, with bearer auth", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-spr-api-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fake = await fakeSpritesApi(root);
    cleanups.push(fake.close);
    const api = spritesApi({ apiUrl: fake.url, token: fake.token });
    const made = await api.create("sf-test-a", { cpus: 2, memoryMb: 2048, storageGb: 10 });
    expect(made.id).toMatch(/^sprite-/);
    await api.create("other-b", { cpus: 2, memoryMb: 2048, storageGb: 10 });
    expect((await api.list("sf-test-")).map((s) => s.name)).toEqual(["sf-test-a"]);
    await api.setEgress("sf-test-a", [{ domain: "github.com", action: "allow" }]);
    expect(await api.getEgress("sf-test-a")).toEqual([{ domain: "github.com", action: "allow" }]);
    const r = await api.exec(
      "sf-test-a",
      ["sh", "-c", "set -eu\n# sf-sprite:cat\ncat; echo err >&2; exit 3"],
      { stdin: "piped in" },
    );
    expect(r.code).toBe(3);
    expect(r.stdout.toString()).toBe("piped in");
    expect(r.stderr.toString()).toBe("err\n");
    await api.destroy("sf-test-a");
    await api.destroy("sf-test-a");
    expect(await api.get("sf-test-a")).toBeNull();
    const wrong = spritesApi({ apiUrl: fake.url, token: "not-it" });
    await expect(
      wrong.create("sf-test-c", { cpus: 2, memoryMb: 2048, storageGb: 10 }),
    ).rejects.toThrow(/401/);
    expect(execUrl("https://api.sprites.dev", "s", ["/bin/sh", "x y"], { tty: "true" })).toBe(
      "wss://api.sprites.dev/v1/sprites/s/exec?cmd=%2Fbin%2Fsh&cmd=x+y&path=%2Fbin%2Fsh&tty=true",
    );
  });

  it("names sprites per runner and job, and maps the allowlist to domain rules", () => {
    expect(spritePrefix("r_abc123")).toBe("sf-abc123-");
    const a = spriteName("sf-abc123-", "job_1");
    expect(a).toMatch(/^sf-abc123-job-1-[0-9a-f]{6}$/);
    expect(spriteName("sf-abc123-", "JOB_1")).not.toBe(a);
    expect(egressRules(["github.com", "*.npmjs.org", "localhost:8080", "github.com"])).toEqual([
      { domain: "*.npmjs.org", action: "allow" },
      { domain: "github.com", action: "allow" },
      { domain: "localhost", action: "allow" },
      { domain: "*", action: "deny" },
    ]);
    const want = egressRules(["github.com"]);
    expect(egressProblems(want, want)).toEqual([]);
    expect(egressProblems(want, [])[0]).toMatch(/no egress policy/);
    expect(egressProblems(want, [...want, { domain: "*", action: "allow" }])).toEqual(
      expect.arrayContaining([expect.stringMatching(/allows everything/)]),
    );
    // Without the trailing deny-all it fails, even with the same allows.
    expect(egressProblems(want, want.slice(0, -1))).toEqual(
      expect.arrayContaining([expect.stringMatching(/doesn't deny everything else/)]),
    );
    // A rule it doesn't understand fails closed when read.
    for (const odd of [
      { include: "defaults" },
      { cidr: "10.0.0.0/8", action: "allow" },
      { domain: "github.com", action: "log" },
      { domain: "github.com", action: "allow", ports: [22] },
    ]) {
      expect(() => parseEgressRules({ rules: [...want, odd] })).toThrow(/doesn't understand/);
    }
    expect(parseEgressRules({ rules: want })).toEqual(want);
    expect(() => parseEgressRules({})).toThrow(/no rules/);
    expect(pinnedClaudeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("parses a pull's output, empty and missing files included", () => {
    const out = Buffer.concat([Buffer.from("0 5 3\nabc1 -1 0\n2 0 0\n")]);
    expect(parsePull(out).map((p) => [p.index, p.size, p.bytes.toString()])).toEqual([
      [0, 5, "abc"],
      [1, -1, ""],
      [2, 0, ""],
    ]);
  });
});

describe("a sprite job's session", { timeout: 30_000 }, () => {
  it("runs end to end: a fresh sprite, egress, the bridge, the verified launch, the result back", async () => {
    const w = await world({ claude: { onPrompt: builds } });
    const before = ownerState(w.owner);
    const j = job();
    const manifest = await w.runner.manifest();
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["cloud-sandbox", "steer", "terminal", "ui-takeover"]),
    );
    expect(manifest.capabilities).not.toContain("own-hardware");
    // Its egress is weaker than a container's: it doesn't claim container isolation.
    expect(manifest.capabilities).not.toContain("container-isolation");
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    expect(session.takeover?.hint).toBe("tmux -L software-factory attach -t sf-job_1");
    const name = spriteName("sf-test-", "job_1");
    const sprite = w.api.sprites.get(name);
    expect(sprite).toBeTruthy();
    if (!sprite) return;
    // The toolchain at the image's pinned version, then the allowlist, before the job's files.
    expect(sprite.provisioned).toEqual([
      [pinnedClaudeVersion(), `/opt/software-factory/claude-code-${pinnedClaudeVersion()}`],
    ]);
    expect(sprite.egress.map((r) => r.domain)).toEqual(
      expect.arrayContaining(["api.anthropic.com", "github.com"]),
    );
    expect(sprite.egress.some((r) => r.domain === "*" && r.action === "allow")).toBe(false);
    expect(sprite.egress.at(-1)).toEqual({ domain: "*", action: "deny" });
    // Its size was sent explicitly.
    expect(sprite.config).toEqual({ cpus: 4, ram_mb: 8192, storage_gb: 50 });
    // The credential went in as a file in memory (/dev/shm); the real entry script loaded it into
    // Claude's environment and deleted it.
    expect(w.credentials).toEqual([TOKEN]);
    const tty = sprite.ttys[0];
    expect(tty?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(tty?.env?.SOFTWARE_FACTORY_ISOLATION).toBe("sprites");
    expect(tty?.argv[2]).toBe("/dev/shm/sf-job_1.env");
    expect(existsSync(join(sprite.root, "dev", "shm", "sf-job_1.env"))).toBe(false);
    // The prompt went into the sprite, and the pointer over the TTY.
    expect(await readFile(join(sprite.root, ws.path, PROMPT_FILE), "utf8")).toBe("add a line");
    // The launch was checked in the sprite (ps, the settings' hashes) before the prompt.
    expect(sprite.execs.some((a) => a[0] === "ps")).toBe(true);
    expect(sprite.execs.some((a) => a[1] === "-c" && a[2]?.includes("sf-sprite:sha256"))).toBe(
      true,
    );
    // The owner's checkout and other work never went in.
    expect(existsSync(join(sprite.root, w.owner))).toBe(false);

    const events = await drain(w.runner.events(j, session, signal()));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });
    expect(events.some((e) => e.type === "tool" && e.name === "Bash")).toBe(true);
    // The sprite is gone once its result is back.
    expect(w.api.sprites.size).toBe(0);
    // The agent's commit is on the run branch in the host's job repo; what it didn't commit is an
    // uncommitted change there, as on a worktree; ignored files stayed in the sprite.
    expect(git(ws.path, "log", "-1", "--format=%s")).toBe("add a line");
    expect(git(ws.path, "rev-parse", `${j.branch}^`)).toBe(w.startSha);
    expect(git(ws.path, "status", "--porcelain")).toBe("M README.md\n?? NEW.md");
    expect(existsSync(join(ws.path, "node_modules"))).toBe(false);
    expect(await readFile(join(ws.path, RESULT_FILE), "utf8")).toBe('{"notes":"ok"}\n');
    expect(
      git(ws.path, "for-each-ref", "--format=%(refname)", "refs/software-factory/sprite-snapshot"),
    ).toBe("");
    const artifacts = await w.runner.collectArtifacts(j, ws, session);
    expect(artifacts.find((a) => a.kind === "log" && a.name === "egress-policy")).toBeTruthy();

    await w.runner.release(j, ws, session);
    await w.runner.release(j, ws, session);
    expect(existsSync(join(w.spritesDir, "sf-job_1"))).toBe(false);
    expect(existsSync(join(w.runsDir, "job_1"))).toBe(false);
    expect(w.tmux.sessions.size).toBe(0);
    expect(ownerState(w.owner)).toEqual(before);
  });

  it("types steers and the prompt pointer through the bridge to the sprite", async () => {
    let agent: FakeAgent | null = null;
    const w = await world({
      claude: {
        onPrompt: (a) => {
          agent = a;
        },
      },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    await w.runner.steer?.(session, "also update the docs");
    for (let i = 0; i < 100 && (agent as FakeAgent | null)?.submitted.length !== 2; i++)
      await sleep(20);
    expect((agent as FakeAgent | null)?.submitted).toEqual([
      PROMPT_POINTER,
      "also update the docs",
    ]);
    await w.runner.release(j, ws, session);
    expect(w.api.sprites.size).toBe(0);
  });

  it("reattaches to the same session when the terminal's socket drops", async () => {
    let agent: FakeAgent | null = null;
    const w = await world({
      claude: {
        onPrompt: (a) => {
          agent = a;
        },
      },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    w.api.drop(spriteName("sf-test-", "job_1"));
    await sleep(150);
    await w.runner.steer?.(session, "still there?");
    for (let i = 0; i < 100 && (agent as FakeAgent | null)?.submitted.length !== 2; i++)
      await sleep(20);
    expect((agent as FakeAgent | null)?.submitted.at(-1)).toBe("still there?");
    expect(w.api.calls.filter((c) => /^WS \/v1\/sprites\/[^/]+\/exec\/1$/.test(c)).length).toBe(1);
    await w.runner.release(j, ws, session);
  });

  it("kills a sprite whose egress policy isn't the job's, before the prompt", async () => {
    const w = await world({
      api: { egressView: (s) => [{ domain: "*", action: "allow" }, ...s.egress] },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const err = await w.runner.startSession(j, ws, signal()).catch((e) => e);
    expect(String(err.message)).toMatch(/allows everything/);
    expect(w.api.sprites.size).toBe(0);
    await w.runner.release(j, ws, undefined);
  });

  it("fails closed on a policy rule it doesn't understand", async () => {
    const w = await world({
      api: { egressView: (s) => [{ include: "defaults" }, ...s.egress] },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const err = await w.runner.startSession(j, ws, signal()).catch((e) => e);
    expect(String(err.message)).toMatch(/can't be checked: .*doesn't understand/);
    expect(w.api.sprites.size).toBe(0);
    await w.runner.release(j, ws, undefined);
  });

  it("fails release loudly when the sprite it made can't be destroyed", async () => {
    const w = await world({ claude: {} });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    const token = await readFile(w.tokenFile, "utf8");
    await rm(w.tokenFile);
    const err = await w.runner.release(j, ws, session).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/may still be running/);
    // The host must not report it released (ADR 0550).
    expect(isReleaseIncomplete(err)).toBe(true);
    expect(w.api.sprites.size).toBe(1);
    // With the token back, a second release destroys it.
    await writeFile(w.tokenFile, token, { mode: 0o600 });
    await w.runner.release(j, ws, session);
    expect(w.api.sprites.size).toBe(0);
  });

  it("kills a process in the sprite that doesn't match its launch record", async () => {
    const w = await world({
      claude: { command: (r) => r.argv.join(" ").replace("bypassPermissions", "default") },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const err = await w.runner.startSession(j, ws, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessConfigMismatch);
    expect(String(err.message)).toMatch(/harness-config-mismatch: .*permission mode default/);
    expect(w.tmux.sessions.size).toBe(0);
    await w.runner.release(j, ws, undefined);
    expect(w.api.sprites.size).toBe(0);
  });

  it("fails a session that wrote the credential into the repo, without a push", async () => {
    const w = await world({
      claude: {
        onPrompt: (agent) => {
          execFileSync("sh", ["-c", `echo "token=${TOKEN}" > leak.txt`], { cwd: agent.work });
          agent.append({ event: "Stop" });
        },
      },
    });
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const session = await w.runner.startSession(j, ws, signal());
    const events = await drain(w.runner.events(j, session, signal()));
    const end = events.at(-1);
    expect(end).toMatchObject({ type: "session.ended", outcome: "failed" });
    expect(end?.type === "session.ended" && end.summary).toMatch(/model credential is in leak.txt/);
    await w.runner.release(j, ws, session);
  });

  it("refuses without a Sprites token or a model credential, before making anything", async () => {
    const noToken = await world({ token: null });
    const j = job();
    await expect(noToken.runner.prepareWorkspace(j, signal())).rejects.toThrow(
      /sf-runner sprites login/,
    );
    expect(noToken.api.sprites.size).toBe(0);
    const noCredential = await world({ credential: null });
    const ws = await noCredential.runner.prepareWorkspace(j, signal());
    await expect(noCredential.runner.startSession(j, ws, signal())).rejects.toThrow(
      /model credential/,
    );
    expect(noCredential.api.sprites.size).toBe(0);
    await noCredential.runner.release(j, ws, undefined);
  });

  it("runs a planning job on the host, as runner-local does", async () => {
    const w = await world();
    const j = job({
      stage: "planning",
      jobId: "job_p",
      planning: {
        sessionId: "ps_1",
        sessionRef: "00000000-0000-4000-8000-000000000001",
        resume: false,
      },
    } as Partial<Job>);
    const ws = await w.runner.prepareWorkspace(j, signal(), {
      planningRelay: { url: "http://127.0.0.1:1", token: "t" },
    });
    expect("sprite" in ws).toBe(false);
    await w.runner.release(j, ws, undefined);
  });

  it("records the sprite it made next to the launch record", async () => {
    const w = await world();
    const j = job();
    const ws = await w.runner.prepareWorkspace(j, signal());
    const record = JSON.parse(await readFile(join(w.runsDir, "job_1", SPRITE_RECORD), "utf8"));
    expect(record.name).toBe(spriteName("sf-test-", "job_1"));
    await w.runner.release(j, ws, undefined);
  });
});

describe("reaping sprite jobs", () => {
  it("destroys this runner's sprites without a live job, and nobody else's", async () => {
    const w = await world();
    const api = spritesApi({ apiUrl: w.api.url, token: w.api.token });
    await api.create(spriteName("sf-test-", "job_live"), {
      cpus: 2,
      memoryMb: 2048,
      storageGb: 10,
    });
    await api.create(spriteName("sf-test-", "job_dead"), {
      cpus: 2,
      memoryMb: 2048,
      storageGb: 10,
    });
    await api.create("sf-other-runner-job-x", { cpus: 2, memoryMb: 2048, storageGb: 10 });
    await api.create("owners-own-sprite", { cpus: 2, memoryMb: 2048, storageGb: 10 });
    await mkdir(join(w.spritesDir, "sf-job_dead"), { recursive: true });
    const reaped = await reapSprites(
      { spritesDir: w.spritesDir, runsDir: w.runsDir, namePrefix: "sf-test-", api },
      new Set(["job_live"]),
    );
    expect(reaped).toEqual(
      expect.arrayContaining([spriteName("sf-test-", "job_dead"), "job_dead"]),
    );
    expect([...w.api.sprites.keys()].sort()).toEqual(
      [spriteName("sf-test-", "job_live"), "owners-own-sprite", "sf-other-runner-job-x"].sort(),
    );
    expect(existsSync(join(w.spritesDir, "sf-job_dead"))).toBe(false);
  });
});
