// A container per job (ADR 0430) with the runner host's real git: runJob drives the container
// adapter (scripted docker and tmux, real git) end to end. The host merges the default branch into
// the job repo, the agent commits inside the "container", and the host pushes the run branch with
// the job token, as it did from a worktree. The owner's checkout is untouched, and a session that
// tampers with its git dir or leaks the credential pushes nothing.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESULT_FILE } from "@software-factory/runner-contract";
import { createContainerRunner } from "@software-factory/runner-local";
import {
  type ScriptedTmuxOptions,
  scriptedDocker,
  scriptedTmux,
} from "@software-factory/runner-local/testing";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema, paths } from "../src/config.ts";
import { FETCH_NAMESPACE } from "../src/git.ts";
import { runJob } from "../src/job.ts";
import { buildRunner } from "../src/runner.ts";
import { controlPlane, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const MODEL_TOKEN = "sk-ant-oat01-the-owners-model-token-0123456789";
const URL = "https://github.com/acme/app.git";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function world(tmux: ScriptedTmuxOptions) {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  // `main` moved on since the item branch was cut: the host merges it before the build.
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
  const scripted = scriptedTmux(tmux);
  const docker = scriptedDocker({ base: scripted.exec });
  const adapter = createContainerRunner({
    exec: docker.exec,
    checkouts: [projects],
    resolveRepoPath: (j) => repo.host.clonePath(j),
    ownReposDir: join(repo.root, "repos"),
    worktreesDir: join(repo.root, "worktrees"),
    runsDir: join(repo.root, "runs"),
    startPoint: (j, path) => repo.host.startPoint(j, path),
    pollMs: 2,
    container: {
      containersDir: join(repo.root, "containers"),
      user: "501:20",
      fetchNamespace: FETCH_NAMESPACE,
      modelCredential: () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: MODEL_TOKEN } }),
    },
  });
  return { ...repo, owner: realpathSync(owner), docker, adapter };
}

const ownerState = (owner: string) => ({
  head: git(owner, "rev-parse", "HEAD"),
  branch: git(owner, "branch", "--show-current"),
  branches: git(owner, "branch", "--list"),
  status: git(owner, "status", "--porcelain"),
  worktrees: git(owner, "worktree", "list"),
  config: execFileSync("cat", [join(owner, ".git", "config")], { encoding: "utf8" }),
});

const agentCommits =
  (extra?: (cwd: string) => void): ScriptedTmuxOptions["onPrompt"] =>
  (s, append) => {
    execFileSync("sh", ["-c", "echo hello >> README.md"], { cwd: s.cwd });
    git(s.cwd, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "add a line");
    extra?.(s.cwd);
    execFileSync("sh", ["-c", `echo '{"notes":"ok"}' > ${RESULT_FILE}`], { cwd: s.cwd });
    append({ event: "Stop" });
  };

describe("a container job and the host's push (ADR 0430 §9)", { timeout: 30_000 }, () => {
  it("merges main, takes the agent's commit and pushes only the run branch with the job token", async () => {
    const w = await world({ onPrompt: agentCommits() });
    const before = ownerState(w.owner);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job({ repo: { ...job().repo, defaultBranch: "main" } });
    cloud.claims.set("c", j);
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.error).toBeUndefined();
    expect(report.outcome).toBe("completed");
    expect(report.headSha).toBe(git(w.bare, "rev-parse", j.branch));
    // The agent's commit on top of the host's merge of main.
    expect(git(w.bare, "log", "-1", "--format=%s", j.branch)).toBe("add a line");
    expect(git(w.bare, "log", "-1", "--format=%s", `${j.branch}^`)).toBe(
      `Merge main into ${j.branch}`,
    );
    expect(git(w.bare, "show", `${j.branch}:MAIN.md`)).toBe("landed on main");
    // Only the run branch was pushed; the owner's checkout is as it was.
    expect(
      git(w.bare, "branch", "--list")
        .split("\n")
        .map((b) => b.trim().replace(/^\* /, ""))
        .sort(),
    ).toEqual(["factory/7-add-a-line", j.branch, "main"].sort());
    expect(ownerState(w.owner)).toEqual(before);
    expect(w.docker.containers.size).toBe(0);
    const events = cloud.events.get(j.jobId) ?? [];
    expect(events.find((e) => e.type === "session.started")).toMatchObject({
      takeover: { hint: `tmux -L software-factory attach -t sf-${j.jobId}` },
    });
  });

  it("pushes nothing when the session leaked the model credential into the repo", async () => {
    const w = await world({
      onPrompt: agentCommits((cwd) => {
        execFileSync("sh", ["-c", `echo "${MODEL_TOKEN}" > notes.txt`], { cwd });
      }),
    });
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job();
    cloud.claims.set("c", j);
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.outcome).toBe("failed");
    expect(report.summary).toMatch(/model credential is in notes\.txt/);
    expect(report.summary).not.toContain(MODEL_TOKEN);
    expect(git(w.bare, "branch", "--list", j.branch)).toBe("");
  });

  it("pushes nothing when the session pointed its git dir elsewhere", async () => {
    const w = await world({
      onPrompt: agentCommits((cwd) => {
        execFileSync("sh", ["-c", "echo ../../evil > ../git/commondir"], { cwd });
      }),
    });
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job();
    cloud.claims.set("c", j);
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.outcome).toBe("failed");
    expect(report.summary).toMatch(/commondir/);
    expect(git(w.bare, "branch", "--list", j.branch)).toBe("");
  });
});

describe("runner.json isolation", () => {
  const base = { runnerId: "r_abc123", key: "k".repeat(32) };
  it("defaults to the sandbox; container isolation declares container-isolation", async () => {
    const dirs = paths({ HOME: "/nonexistent-home" });
    const sandbox = buildRunner(configSchema.parse(base), dirs);
    expect((await sandbox.adapter.manifest()).capabilities).not.toContain("container-isolation");
    const contained = buildRunner(configSchema.parse({ ...base, isolation: "container" }), dirs);
    expect((await contained.adapter.manifest()).capabilities).toContain("container-isolation");
  });

  it("keeps the model credential out of `status`", async () => {
    const { redacted } = await import("../src/config.ts");
    const config = configSchema.parse({
      ...base,
      isolation: "container",
      container: { env: { CLAUDE_CODE_OAUTH_TOKEN: MODEL_TOKEN } },
    });
    expect(JSON.stringify(redacted(config))).not.toContain(MODEL_TOKEN);
    expect(() => configSchema.parse({ ...base, container: { env: { OTHER: "x" } } })).toThrow();
  });
});
