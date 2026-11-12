// A sprite per job (ADR 0480) with the runner host's real git: runJob drives the sprites adapter
// against the fake Sprites API (its scripts run for real in a directory per sprite) end to end.
// The host merges the default branch into the job repo, the agent commits in the "sprite", the
// result comes back as a bundle and the host pushes the run branch with the job token. Neither the
// job token nor the Sprites token ever reaches the sprite; a leaked model credential pushes nothing.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_FILE } from "@software-factory/runner-contract";
import { createSpritesRunner, spritesApi } from "@software-factory/runner-local";
import {
  bridgeSpawn,
  type FakeAgent,
  fakeClaude,
  fakeSpritesApi,
  scriptedTmux,
} from "@software-factory/runner-local/testing";
import { afterEach, describe, expect, it } from "vitest";
import { accountPaths, activeAccount, addTokenAccount, useAccount } from "../src/accounts.ts";
import { configSchema, paths } from "../src/config.ts";
import { FETCH_NAMESPACE } from "../src/git.ts";
import { runJob } from "../src/job.ts";
import { buildRunner, hostModelCredential } from "../src/runner.ts";
import { spritesCommand } from "../src/sprites-cli.ts";
import { controlPlane, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const BASE = { runnerId: "r_abc123", key: "k".repeat(32), isolation: "sprites" };
const MODEL_TOKEN = "sk-ant-oat01-the-owners-model-token-0123456789";
const URL = "https://github.com/acme/app.git";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Every file under a directory, for "this secret is nowhere in the sprite". */
function allText(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    // The fake's own record of Claude's environment, not a file in the sprite.
    if (name === ".fake" || name.startsWith(".fake/")) continue;
    const path = join(dir, name);
    if (statSync(path, { throwIfNoEntry: false })?.isFile()) out += readFileSync(path, "latin1");
  }
  return out;
}

async function world(onPrompt: (agent: FakeAgent) => void) {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  const seed = join(repo.root, "seed");
  git(seed, "checkout", "-q", "main");
  await writeFile(join(seed, "MAIN.md"), "landed on main\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-qm", "main moves");
  git(seed, "push", "-q", repo.bare, "main");
  const projects = join(repo.root, "projects");
  const owner = join(projects, "app");
  git(repo.root, "clone", "-q", repo.bare, owner);
  git(owner, "remote", "set-url", "origin", URL);
  git(owner, "checkout", "-q", "-b", "owner-work");
  await writeFile(join(owner, "WIP.txt"), "uncommitted\n");
  // The host's Claude accounts (ADR 0410): a token account, active. The sprite gets its token.
  const accounts = accountPaths(paths({ HOME: join(repo.root, "home") }));
  await addTokenAccount(accounts, "work", MODEL_TOKEN);
  await useAccount(accounts, "work");
  const sprites: string[] = [];
  const api = await fakeSpritesApi(join(repo.root, "cloud"), {
    onTty: (tty, map) => {
      sprites.push(tty.sprite.root);
      fakeClaude({ onPrompt })(tty, map);
    },
  });
  cleanups.push(api.close);
  const tokenFile = join(repo.root, "config", "sprites.token");
  execFileSync("mkdir", ["-p", join(repo.root, "config")]);
  await writeFile(tokenFile, `${api.token}\n`, { mode: 0o600 });
  const tmux = scriptedTmux({ spawn: bridgeSpawn() });
  const adapter = createSpritesRunner({
    exec: tmux.exec,
    account: () => activeAccount(accounts),
    checkouts: [projects],
    resolveRepoPath: (j) => repo.host.clonePath(j),
    ownReposDir: join(repo.root, "repos"),
    worktreesDir: join(repo.root, "worktrees"),
    runsDir: join(repo.root, "runs"),
    startPoint: (j, path) => repo.host.startPoint(j, path),
    pollMs: 5,
    sprites: {
      apiUrl: api.url,
      tokenFile,
      spritesDir: join(repo.root, "sprites"),
      namePrefix: "sf-abc123-",
      mirrorMs: 5,
      fetchNamespace: FETCH_NAMESPACE,
      modelCredential: hostModelCredential(configSchema.parse(BASE), {}),
    },
  });
  return { ...repo, owner: realpathSync(owner), api, adapter, accounts, sprites };
}

const ownerState = (owner: string) => ({
  head: git(owner, "rev-parse", "HEAD"),
  branch: git(owner, "branch", "--show-current"),
  branches: git(owner, "branch", "--list"),
  status: git(owner, "status", "--porcelain"),
  worktrees: git(owner, "worktree", "list"),
});

const agentCommits =
  (extra?: (agent: FakeAgent) => void) =>
  (agent: FakeAgent): void => {
    execFileSync("sh", ["-c", "echo hello >> README.md"], { cwd: agent.work });
    agent.git("commit", "-qam", "add a line");
    extra?.(agent);
    execFileSync("sh", ["-c", `echo '{"notes":"ok"}' > ${RESULT_FILE}`], { cwd: agent.work });
    agent.append({ event: "Stop" });
  };

describe("a sprite job and the host's push (ADR 0480)", { timeout: 30_000 }, () => {
  it("merges main, takes the agent's work back and pushes only the run branch with the job token", async () => {
    let tree = "";
    const w = await world(
      agentCommits((agent) => {
        execFileSync("sh", ["-c", "echo left over > LEFTOVER.md"], { cwd: agent.work });
        // What is in the sprite while the agent works: never a job token or the Sprites token.
        tree = allText(agent.map("/"));
      }),
    );
    const before = ownerState(w.owner);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job({ repo: { ...job().repo, defaultBranch: "main" } });
    cloud.claims.set("c", j);
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.error).toBeUndefined();
    expect(report.outcome).toBe("completed");
    expect(report.headSha).toBe(git(w.bare, "rev-parse", j.branch));
    // The host's leftovers commit on the agent's commit on the host's merge of main.
    expect(git(w.bare, "log", "-1", "--format=%s", j.branch)).toMatch(/uncommitted changes/);
    expect(git(w.bare, "show", `${j.branch}:LEFTOVER.md`)).toBe("left over");
    expect(git(w.bare, "log", "-1", "--format=%s", `${j.branch}^`)).toBe("add a line");
    expect(git(w.bare, "log", "-1", "--format=%s", `${j.branch}^^`)).toBe(
      `Merge main into ${j.branch}`,
    );
    expect(git(w.bare, "show", `${j.branch}:MAIN.md`)).toBe("landed on main");
    expect(
      git(w.bare, "branch", "--list")
        .split("\n")
        .map((b) => b.trim().replace(/^\* /, ""))
        .sort(),
    ).toEqual(["factory/7-add-a-line", j.branch, "main"].sort());
    expect(ownerState(w.owner)).toEqual(before);
    expect(w.api.sprites.size).toBe(0);
    // The job token, the Sprites token and the owner's other work never went into the sprite.
    expect(tree).toContain("hello");
    expect(tree).not.toMatch(/ghs_fake_/);
    expect(tree).not.toContain(w.api.token);
    expect(tree).not.toContain("uncommitted\n");
    expect(tree).not.toContain(MODEL_TOKEN);
    const events = cloud.events.get(j.jobId) ?? [];
    expect(events.find((e) => e.type === "session.started")).toMatchObject({
      takeover: { hint: `tmux -L software-factory attach -t sf-${j.jobId}` },
    });
  });

  it("pushes nothing when the session leaked the model credential into the repo", async () => {
    const w = await world(
      agentCommits((agent) => {
        execFileSync("sh", ["-c", `echo "${MODEL_TOKEN}" > notes.txt`], { cwd: agent.work });
      }),
    );
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job();
    cloud.claims.set("c", j);
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.outcome).toBe("failed");
    expect(report.summary).toMatch(/model credential is in notes\.txt/);
    expect(report.summary).not.toContain(MODEL_TOKEN);
    expect(git(w.bare, "branch", "--list", j.branch)).toBe("");
    expect(w.api.sprites.size).toBe(0);
  });
});

describe("runner.json sprites isolation", () => {
  it("declares cloud-sandbox and not own-hardware, and keeps no token in runner.json", async () => {
    const dirs = paths({ HOME: "/nonexistent-home" });
    const runner = buildRunner(configSchema.parse(BASE), dirs);
    const caps = (await runner.adapter.manifest()).capabilities;
    expect(caps).toEqual(expect.arrayContaining(["cloud-sandbox", "terminal"]));
    expect(caps).not.toContain("own-hardware");
    expect(caps).not.toContain("container-isolation");
    expect(dirs.spritesTokenFile).toBe("/nonexistent-home/.config/software-factory/sprites.token");
    expect(() => configSchema.parse({ ...BASE, sprites: { token: "x" } })).toThrow();
    expect(
      configSchema.parse({ ...BASE, sprites: { allowedHosts: ["pypi.org"] } }).sprites,
    ).toEqual({
      allowedHosts: ["pypi.org"],
    });
  });
});

describe("sf-runner sprites", () => {
  it("logs in with a checked token kept 0600, shows status, logs out", async () => {
    const root = await mkdtemp(join(tmpdir(), "sf-spr-cli-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const fake = await fakeSpritesApi(join(root, "cloud"));
    cleanups.push(fake.close);
    const lines: string[] = [];
    const tokenFile = join(root, "config", "sprites.token");
    const deps = (stdin: string) => ({
      tokenFile,
      namePrefix: "sf-abc123-",
      isolation: "sandbox",
      readStdin: async () => stdin,
      api: (token: string) => spritesApi({ apiUrl: fake.url, token }),
      readToken: async () => (await readFile(tokenFile, "utf8")).trim(),
      log: (l: string) => lines.push(l),
    });
    expect(await spritesCommand(["login"], deps("wrong-token"))).toBe(1);
    expect(lines.at(-1)).toMatch(/refused the token: .*401/);
    expect(await spritesCommand(["login"], deps(`${fake.token}\n`))).toBe(0);
    expect((await readFile(tokenFile, "utf8")).trim()).toBe(fake.token);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(lines.at(-1)).toMatch(/"isolation": "sprites"/);
    await spritesApi({ apiUrl: fake.url, token: fake.token }).create("sf-abc123-job-1-aaaaaa", {
      cpus: 1,
      memoryMb: 1024,
      storageGb: 10,
    });
    expect(await spritesCommand(["status"], deps(""))).toBe(0);
    expect(lines).toContain("  sf-abc123-job-1-aaaaaa  running");
    expect(lines.join("\n")).not.toContain(fake.token);
    expect(await spritesCommand(["logout"], deps(""))).toBe(0);
    await expect(stat(tokenFile)).rejects.toThrow();
    expect(await spritesCommand(["nope"], deps(""))).toBe(2);
  });
});
