// ADR 0260 against a scripted Orca CLI: a stateful fake `orca` (repos, projects, worktrees) over
// real git, driving the real runner-orca adapter and the host's git. Incident 2026-11-11 (#5): the
// runner registered its own clone next to the owner's checkout and churned a new repo per job.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { canonicalKeyFromUrl, type Job, RESULT_FILE } from "@software-factory/runner-contract";
import {
  createOrcaRunner,
  diagnose,
  type Exec,
  migrateRunnerRepos,
  nodeExec,
  pickRepo,
} from "@software-factory/runner-orca";
import { afterEach, describe, expect, it } from "vitest";
import { FETCH_NAMESPACE } from "../src/git.ts";
import { runJob } from "../src/job.ts";
import { controlPlane, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const TOKEN = "ghs_SECRET_never_on_disk_0123456789";
const URL = "https://github.com/acme/app.git";

interface FakeRepo {
  id: string;
  path: string;
  displayName: string;
  kind: "git";
  addedAt: number;
  gitRemoteIdentity: { canonicalKey: string; remoteName: string; remoteUrl: string } | null;
}
interface FakeWorktree {
  worktreeId: string;
  repoId: string;
  path: string;
  branch: string;
  comment: string;
}

/** A scripted `orca`: answers like the real CLI's `--json`, backed by real git worktrees. */
function fakeOrca(root: string) {
  const repos = new Map<string, FakeRepo>();
  const worktrees = new Map<string, FakeWorktree>();
  const counts = { add: 0, forget: 0, create: 0 };
  let seq = 0;
  /** What a launched "agent" does in its worktree. */
  let onLaunch: ((worktree: string) => void) | null = null;
  const ok = (result: unknown) => ({
    stdout: JSON.stringify({ ok: true, result }),
    stderr: "",
    code: 0,
  });
  const fail = (code: string) => ({
    stdout: JSON.stringify({ ok: false, error: { code, message: code } }),
    stderr: "",
    code: 1,
  });

  function register(path: string): FakeRepo {
    const url = (() => {
      try {
        return git(path, "remote", "get-url", "origin");
      } catch {
        return null;
      }
    })();
    const key = url ? canonicalKeyFromUrl(url) : null;
    const repo: FakeRepo = {
      id: `repo-${++seq}`,
      path,
      displayName: basename(path),
      kind: "git",
      addedAt: seq,
      gitRemoteIdentity:
        url && key ? { canonicalKey: key, remoteName: "origin", remoteUrl: url } : null,
    };
    repos.set(repo.id, repo);
    return repo;
  }

  const exec: Exec = async (cmd, args, options) => {
    if (cmd !== "orca") return nodeExec(cmd, args, options);
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const verb = args
      .filter((a) => !a.startsWith("--"))
      .slice(0, 2)
      .join(" ");
    switch (verb) {
      case "repo list":
        return ok({ repos: [...repos.values()] });
      case "repo add": {
        counts.add++;
        const path = flag("--path") ?? "";
        const existing = [...repos.values()].find((r) => r.path === path);
        return ok({ repo: existing ?? register(path) });
      }
      case "project list": {
        const byKey = new Map<string, FakeRepo[]>();
        for (const r of repos.values()) {
          const k = r.gitRemoteIdentity?.canonicalKey ?? `local:${r.id}`;
          byKey.set(k, [...(byKey.get(k) ?? []), r]);
        }
        return ok({
          projects: [...byKey].map(([k, list]) => ({
            id: `github:${k.replace(/^github\.com\//, "")}`,
            displayName: list[0]?.displayName,
            gitRemoteIdentity: list[0]?.gitRemoteIdentity,
            sourceRepoIds: list.map((r) => r.id),
          })),
        });
      }
      case "project setup-delete": {
        counts.forget++;
        const id = flag("--setup") ?? "";
        if (!repos.delete(id)) return fail("not_found");
        return ok({ deleted: true });
      }
      case "worktree create": {
        counts.create++;
        const repo = repos.get((flag("--repo") ?? "").replace(/^id:/, ""));
        if (!repo) return fail("repo_not_found");
        const path = join(root, "workspaces", repo.displayName, flag("--name") ?? "wt");
        const branch = flag("--branch") ?? "";
        await mkdir(join(path, ".."), { recursive: true });
        git(repo.path, "worktree", "add", "-q", "-b", branch, path, flag("--base-branch") ?? "");
        const wt: FakeWorktree = {
          worktreeId: `${repo.id}::${path}`,
          repoId: repo.id,
          path,
          branch: `refs/heads/${branch}`,
          comment: flag("--comment") ?? "",
        };
        worktrees.set(wt.worktreeId, wt);
        return ok({
          worktree: {
            id: wt.worktreeId,
            repoId: repo.id,
            path,
            branch: wt.branch,
            head: git(path, "rev-parse", "HEAD"),
            comment: wt.comment,
          },
        });
      }
      case "worktree rm": {
        const id = (flag("--worktree") ?? "").replace(/^id:/, "");
        const wt = worktrees.get(id);
        if (!wt) return fail("not_found");
        const repo = repos.get(wt.repoId);
        if (repo && existsSync(repo.path)) {
          execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repo.path });
        }
        worktrees.delete(id);
        return ok({ removed: true });
      }
      case "worktree ps":
        return ok({
          worktrees: [...worktrees.values()].map((w) => ({
            ...w,
            agents: [
              {
                paneKey: "p:1",
                agentType: "claude",
                state: "done",
                stateStartedAt: Date.now() + 60_000,
                hasLivePty: true,
                lastAssistantMessage: "done",
              },
            ],
          })),
        });
      case "agent launch": {
        const wt = worktrees.get((flag("--worktree") ?? "").replace(/^id:/, ""));
        if (wt && onLaunch) onLaunch(wt.path);
        return ok({ launch: { outcome: { kind: "terminal", handle: "term_1", paneKey: "p:1" } } });
      }
      case "terminal read":
        return ok({ terminal: { handle: "term_1", status: "running", tail: [] } });
      case "terminal close":
        return ok({ closed: 1 });
      default:
        return fail(`unscripted: ${verb}`);
    }
  };
  return {
    exec,
    repos,
    worktrees,
    counts,
    register,
    onLaunch: (fn: (worktree: string) => void) => {
      onLaunch = fn;
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** "GitHub" (a bare repo), the owner's own checkout of it, the runner's state dir, a fake Orca. */
async function world(options: { ownerCheckout?: boolean } = {}) {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  const reposDir = join(repo.root, "repos"); // the host's clone dir (scratchRepo's hostGit uses it)
  const orca = fakeOrca(repo.root);
  let owner: string | null = null;
  if (options.ownerCheckout ?? true) {
    owner = join(repo.root, "projects", "app");
    git(repo.root, "clone", "-q", repo.bare, owner);
    git(owner, "remote", "set-url", "origin", URL); // what the owner's checkout really points at
    await writeFile(join(owner, ".env"), "OWNER_SECRET=1\n");
    git(owner, "checkout", "-q", "-b", "owner-work");
    await writeFile(join(owner, "WIP.txt"), "uncommitted\n");
  }
  const adapter = createOrcaRunner({
    exec: orca.exec,
    runsDir: join(repo.root, "runs"),
    resolveRepoPath: (j) => repo.host.clonePath(j),
    ownReposDir: reposDir,
    startPoint: (j, path) => repo.host.startPoint(j, path),
    pollMs: 1,
  });
  return { ...repo, reposDir, orca, owner, adapter };
}

type World = Awaited<ReturnType<typeof world>>;

/** One job's workspace lifecycle, as runJob drives it: resolve → fetch → prepare → release. */
async function cycle(w: World, j: Job) {
  const existing = await w.adapter.resolveCheckout?.(j);
  const checkout = await w.host.ensureRepo(j, TOKEN, existing ?? null);
  const ws = await w.adapter.prepareWorkspace(j, new AbortController().signal);
  const during = { repos: [...w.orca.repos.keys()], worktree: ws.path, repoId: ws.repoId };
  await w.adapter.release(j, ws, undefined);
  return { existing, checkout, ws, during };
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
  status: git(owner, "status", "--porcelain"),
  remote: git(owner, "remote", "-v"),
  config: execFileSync("cat", [join(owner, ".git", "config")], { encoding: "utf8" }),
  fetchHead: existsSync(join(owner, ".git", "FETCH_HEAD")),
});

describe("workspace resolution (ADR 0260)", { timeout: 30_000 }, () => {
  it("runs jobs in the owner's existing Orca repo, never a second registration, no churn", async () => {
    const w = await world();
    const owner = w.owner as string;
    const ownerRepo = w.orca.register(owner);
    const before = ownerState(owner);

    for (let n = 1; n <= 3; n++) {
      const j = job({ jobId: `job_${n}`, runNo: n, branch: `factory/7-add-a-line-run-${n}` });
      const { existing, checkout, ws, during } = await cycle(w, j);
      expect(existing).toBe(owner);
      expect(checkout).toBe(owner);
      expect(during.repoId).toBe(ownerRepo.id);
      expect(during.repos).toEqual([ownerRepo.id]); // one repo, the same id, every job
      expect(ws.path.startsWith(owner)).toBe(false); // its own worktree, not the owner's checkout
      expect(ws.baseSha).toBe(git(w.bare, "rev-parse", "factory/7-add-a-line"));
      // Released: the worktree and run branch are gone, the repo stays.
      expect(existsSync(ws.path)).toBe(false);
      expect(git(owner, "branch", "--list", j.branch)).toBe("");
    }
    expect(w.orca.counts).toMatchObject({ add: 0, forget: 0, create: 3 });
    expect([...w.orca.repos.keys()]).toEqual([ownerRepo.id]);
    expect(existsSync(w.reposDir)).toBe(false); // no clone made

    // The owner's checkout: same branch, head, uncommitted work, remotes, config; no FETCH_HEAD.
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

  it("matches the remote by canonical identity, whatever its form or case", () => {
    expect(canonicalKeyFromUrl("git@github.com:Acme/App.git")).toBe("github.com/acme/app");
    expect(canonicalKeyFromUrl("https://github.com/acme/app")).toBe("github.com/acme/app");
    expect(canonicalKeyFromUrl("ssh://git@github.com/acme/app.git")).toBe("github.com/acme/app");
    expect(canonicalKeyFromUrl("https://gitlab.com/acme/app.git")).toBeNull();
    const repo = (id: string, own: boolean, addedAt: number) => ({
      id,
      path: `/p/${id}`,
      realPath: `/p/${id}`,
      displayName: "app",
      kind: "git",
      addedAt,
      own,
      key: "github.com/acme/app",
    });
    // The owner's checkout wins over the runner's clone, even one added earlier.
    expect(
      pickRepo([repo("clone", true, 1), repo("mine", false, 2)], "github.com/acme/app")?.id,
    ).toBe("mine");
    expect(pickRepo([repo("mine", false, 2)], "github.com/acme/other")).toBeNull();
  });

  it("with no Orca repo for the remote: clones once, registers once, keeps it", async () => {
    const w = await world({ ownerCheckout: false });
    const ids = new Set<string>();
    for (let n = 1; n <= 3; n++) {
      const j = job({ jobId: `job_${n}`, runNo: n, branch: `factory/7-add-a-line-run-${n}` });
      const { existing, checkout, during } = await cycle(w, j);
      const clone = n === 1 ? null : realpathSync(w.host.clonePath(j));
      expect(existing).toBe(clone); // registered by its real path
      expect(checkout).toBe(existing ?? w.host.clonePath(j));
      ids.add(during.repoId);
      expect(w.orca.repos.size).toBe(1); // still registered after release
    }
    expect(ids.size).toBe(1);
    expect(w.orca.counts).toMatchObject({ add: 1, forget: 0 });
    const [registered] = w.orca.repos.values();
    expect(registered?.displayName).toBe("app"); // named after the project
    const config = await readFile(join(w.host.clonePath(job()), ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
  });

  it("migrates: retires the runner's earlier clone once nothing uses it", async () => {
    const w = await world();
    const owner = w.owner as string;
    // The incident: the runner's clone registered next to the owner's checkout, with a job on it.
    const j = job({ jobId: "job_old" });
    await w.host.ensureRepo(j, TOKEN, null);
    const clone = w.orca.register(w.host.clonePath(j));
    const ownerRepo = w.orca.register(owner);
    await w.orca.exec("orca", [
      "worktree",
      "create",
      "--repo",
      `id:${clone.id}`,
      "--name",
      "sf-job_old",
      "--branch",
      j.branch,
      "--base-branch",
      `${FETCH_NAMESPACE}/${j.repo.baseRef}`,
      "--comment",
      "sf-job:job_old",
    ]);

    // Still live (or unknown): left alone.
    const opts = { exec: w.orca.exec, ownReposDir: w.reposDir };
    expect((await migrateRunnerRepos({ ...opts, live: new Set(["job_old"]) }))[0]?.skipped).toMatch(
      /job_old/,
    );
    expect((await migrateRunnerRepos({ ...opts, live: null }))[0]?.skipped).toBeTruthy();
    expect(w.orca.repos.has(clone.id)).toBe(true);
    const findings = await diagnose({ ...opts, live: new Set() });
    expect(findings.map((f) => f.kind).sort()).toEqual(["duplicate-repos", "orphan-worktree"]);
    expect(findings.every((f) => f.fixable)).toBe(true);

    // Nothing running it: worktree removed, clone unregistered and deleted, owner's repo kept.
    const [m] = await migrateRunnerRepos({ ...opts, live: new Set() });
    expect(m).toMatchObject({ kept: { id: ownerRepo.id }, retired: { id: clone.id } });
    expect(m?.skipped).toBeUndefined();
    expect(m?.removedWorktrees).toHaveLength(1);
    expect([...w.orca.repos.keys()]).toEqual([ownerRepo.id]);
    expect(existsSync(w.host.clonePath(j))).toBe(false);
    expect(await diagnose({ ...opts, live: new Set() })).toEqual([]);

    // The next job resolves to the owner's repo.
    expect(await w.adapter.resolveCheckout?.(job())).toBe(owner);
  });

  it("doctor leaves two of the owner's own checkouts alone (not fixable here)", async () => {
    const w = await world();
    const second = join(w.root, "projects", "app-2");
    git(w.root, "clone", "-q", w.bare, second);
    git(second, "remote", "set-url", "origin", URL);
    w.orca.register(w.owner as string);
    w.orca.register(second);
    const findings = await diagnose({
      exec: w.orca.exec,
      ownReposDir: w.reposDir,
      live: new Set(),
    });
    expect(findings).toEqual([
      expect.objectContaining({ kind: "duplicate-repos", fixable: false }),
    ]);
    expect(
      await migrateRunnerRepos({ exec: w.orca.exec, ownReposDir: w.reposDir, live: null }),
    ).toEqual([]);
    expect(w.orca.repos.size).toBe(2);
  });

  it("runJob end to end: builds in the owner's repo and pushes only the run branch", async () => {
    const w = await world();
    const owner = w.owner as string;
    w.orca.register(owner);
    const before = ownerState(owner);
    w.orca.onLaunch((wt) => {
      execFileSync("sh", ["-c", "echo hello >> README.md"], { cwd: wt });
      git(wt, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "add a line");
      execFileSync("sh", ["-c", `echo '{"notes":"ok"}' > ${RESULT_FILE}`], { cwd: wt });
    });
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job();
    cloud.claims.set("c", j);
    const report = await runJob({ adapter: w.adapter, cp, git: w.host, job: j, flushMs: 5 });
    expect(report.error).toBeUndefined();
    expect(report.outcome).toBe("completed");
    expect(report.headSha).toBe(git(w.bare, "rev-parse", j.branch));
    expect(w.orca.counts).toMatchObject({ add: 0, forget: 0 });
    expect(ownerState(owner)).toEqual(before);
    expect(git(owner, "branch", "--list", j.branch)).toBe("");
    await rm(join(w.root, "runs"), { recursive: true, force: true });
  });
});
