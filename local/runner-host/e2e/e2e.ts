// End to end on this machine: the real engine (apps/engine) under `wrangler dev` with its in-D1 fake
// GitHub, the real runner host + runner-local + harness-claude, and real Claude Code sessions in
// tmux, in git worktrees. A scratch bare repo stands in for GitHub's git side; the driver mirrors each real push
// into the fake so the engine's hand-back and fast-forward checks run unchanged.
//
//   1. start the engine + driver:  see local/runner-host/README.md, "End-to-end test"
//   2. node --experimental-transform-types e2e/e2e.ts [--driver http://127.0.0.1:8977]
//
// It files one small work item, lets the factory triage, build and verify it, and stops at the merge
// gate. Then it cancels the item and checks that nothing the runner made is left in tmux or git.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Job } from "@software-factory/runner-contract";
import { sessionName, tmuxCli } from "@software-factory/runner-local";
import { configSchema, type Paths } from "../src/config.ts";
import { buildRunner } from "../src/runner.ts";

const { values } = parseArgs({
  options: {
    driver: { type: "string", default: "http://127.0.0.1:8977" },
    timeout: { type: "string", default: String(40 * 60_000) },
    keep: { type: "boolean", default: false },
  },
});
const DRIVER = values.driver as string;
const OWNER = "acme";
const NAME = `sf-e2e-${Date.now().toString(36)}`;
const REPO_KEY = `${OWNER}/${NAME}`;
const CANONICAL = `https://github.com/${OWNER}/${NAME}.git`;
const LINE = "Built by the software factory.";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
const post = async <T>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(`${DRIVER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(`${path}: ${out.error ?? r.status}`);
  return out;
};
const sql = <T>(query: string, ...params: unknown[]) => post<T[]>("/sql", { sql: query, params });
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};

// ---- the scratch repo ("GitHub") ----
const root = await mkdtemp(join(tmpdir(), "sf-e2e-runner-"));
const seed = join(root, "seed");
const bare = join(root, "origin.git");
execFileSync("mkdir", ["-p", seed]);
git(seed, "init", "-q", "-b", "main");
await writeFile(
  join(seed, "README.md"),
  "# Scratch\n\nA scratch repository for the runner end-to-end test.\n",
);
await writeFile(
  join(seed, "AGENTS.md"),
  "# AGENTS.md\n\nA scratch repository with no code, no tests and no tooling. There is nothing to lint, typecheck or test: report those checks as skipped.\n",
);
git(seed, "add", ".");
git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "commit", "-qm", "init");
git(root, "clone", "-q", "--bare", seed, bare);

// ---- the world ----
const world = await post<{ userId: string; projectId: string; runnerId: string; key: string }>(
  "/seed",
  {
    owner: OWNER,
    name: NAME,
    policy: {
      version: 1,
      autonomyPolicy: "balanced",
      overrides: { agent: { outbound: "allow" } },
      retryLimit: 1,
    },
  },
);
console.log(`world: project ${world.projectId}, runner ${world.runnerId}`);

const dirs: Paths = {
  configFile: join(root, "config", "runner.json"),
  configDir: join(root, "config"),
  stateDir: join(root, "state"),
  reposDir: join(root, "state", "repos"),
  runsDir: join(root, "state", "runs"),
  worktreesDir: join(root, "state", "worktrees"),
  logDir: join(root, "logs"),
};
const config = configSchema.parse({
  baseUrl: DRIVER,
  runnerId: world.runnerId,
  key: world.key,
  maxConcurrent: 1,
  heartbeatMs: 5_000,
  repoUrlMap: { [CANONICAL]: bare },
});

// The fake GitHub bridge: on claim, put the item branch in the bare repo where the fake says it is;
// on a build's hand-back, record the real pushed commit in the fake.
const jobs = new Map<string, { job: Job; baseSha: string }>();
const bridge: typeof fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const handback = url.pathname.match(/^\/runner\/v1\/jobs\/([^/]+)\/handback$/);
  if (handback && body?.headSha) {
    const known = jobs.get(decodeURIComponent(handback[1] ?? ""));
    if (known) {
      await post("/fake/mirror", {
        repo: REPO_KEY,
        branch: body.branch,
        sha: body.headSha,
        parentBranch: known.job.repo.baseRef,
        realParent: known.baseSha,
      });
    }
  }
  const response = await fetch(input, init);
  if (url.pathname === "/runner/v1/claim" && response.ok) {
    const text = await response.clone().text();
    const job = (JSON.parse(text) as { job: Job | null }).job;
    if (job) {
      const { sha } = await post<{ sha: string | null }>("/fake/ref", {
        repo: REPO_KEY,
        branch: job.repo.baseRef,
      });
      const isCommit =
        !!sha &&
        spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: bare }).status === 0;
      const real = isCommit && sha ? sha : git(bare, "rev-parse", "main");
      git(bare, "update-ref", `refs/heads/${job.repo.baseRef}`, real);
      jobs.set(job.jobId, { job, baseSha: real });
      console.log(
        `  claim: ${job.stage} ${job.jobId} on ${job.branch} from ${job.repo.baseRef} @ ${real.slice(0, 7)}`,
      );
    }
  }
  return response;
};
const { host } = buildRunner(config, dirs, {
  fetch: bridge,
  log: (m) => console.log(`  [runner] ${m}`),
});
const tmux = tmuxCli();

let workItemId = "";
try {
  const item = await post<{ workItemId: string; branch: string }>("/invoke", {
    op: "workItem.create",
    actorId: world.userId,
    input: {
      projectId: world.projectId,
      title: "Add a closing line to README.md",
      body: `Append one line to the end of README.md that reads exactly: "${LINE}". Change nothing else.`,
      source: "app",
    },
  });
  workItemId = item.workItemId;
  console.log(`work item ${workItemId} on ${item.branch}`);
  const started = Date.now();
  await host.start();

  const deadline = started + Number(values.timeout);
  let state = "";
  for (;;) {
    const [w] = await sql<{ status: string; stage: string | null }>(
      "SELECT status, stage FROM core_work_items WHERE id = ?",
      workItemId,
    );
    const [gate] = await sql<{ kind: string }>(
      "SELECT kind FROM core_pending_actions WHERE work_item_id = ? AND status = 'pending'",
      workItemId,
    );
    const now = `${w?.status}/${w?.stage ?? "-"}${gate ? ` gate:${gate.kind}` : ""}`;
    if (now !== state) console.log(`item: ${now}`);
    state = now;
    if (gate?.kind === "merge") break;
    if (w && ["failed", "cancelled", "rejected", "done"].includes(w.status)) break;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.log(`\nreached ${state} in ${((Date.now() - started) / 60_000).toFixed(1)} min`);
  await host.stop();

  const runs = await sql<{
    stage: string;
    status: string;
    outcome: string;
    branch: string;
    head_sha: string | null;
    summary: string | null;
  }>(
    "SELECT stage, status, outcome, branch, head_sha, summary FROM core_runs WHERE work_item_id = ? ORDER BY run_no",
    workItemId,
  );
  for (const r of runs) {
    console.log(
      `  run ${r.stage}: ${r.status}/${r.outcome} ${r.branch} ${r.head_sha?.slice(0, 7) ?? ""}`,
    );
  }
  check(state.includes("gate:merge"), "the item reached the merge gate");
  check(
    ["triage", "build", "verify"].every((s) =>
      runs.some((r) => r.stage === s && r.status === "handed_back"),
    ),
    "triage, build and verify runs all handed back",
  );
  const build = runs.find((r) => r.stage === "build" && r.status === "handed_back");
  if (build?.head_sha) {
    check(
      git(bare, "rev-parse", build.branch) === build.head_sha,
      `run branch ${build.branch} pushed at its head`,
    );
    check(
      git(bare, "show", `${build.head_sha}:README.md`).includes(LINE),
      "the pushed commit adds the line",
    );
    check(
      !git(bare, "ls-tree", "-r", "--name-only", build.head_sha).includes(".factory-result.json") &&
        !git(bare, "ls-tree", "-r", "--name-only", build.head_sha).includes(
          ".claude/settings.local.json",
        ),
      "no result file or harness settings were committed",
    );
    const refs = git(bare, "for-each-ref", "--format=%(refname:short)").split("\n");
    check(
      refs.every((r) => r === "main" || r.startsWith("factory/")),
      `only factory/* branches were pushed (${refs.join(", ")})`,
    );
  }
  const [packet] = await sql<{ verdict: string }>(
    "SELECT verdict FROM core_review_packets WHERE work_item_id = ?",
    workItemId,
  );
  check(!!packet, `a review packet was recorded (${packet?.verdict})`);
  const artifacts = await sql<{ kind: string; name: string | null }>(
    "SELECT a.kind, a.name FROM core_artifacts a JOIN core_runs r ON r.id = a.run_id WHERE r.work_item_id = ?",
    workItemId,
  );
  check(
    artifacts.some((a) => a.kind === "diff"),
    `artifacts stored (${artifacts.map((a) => a.name ?? a.kind).join(", ")})`,
  );
} finally {
  await host.stop({ cancel: true, timeoutMs: 60_000 }).catch(() => {});
  if (workItemId) {
    await post("/invoke", {
      op: "workItem.cancel",
      actorId: world.userId,
      input: { workItemId, reason: "e2e finished" },
    }).catch((e) => console.log(`cancel: ${e}`));
  }
  // Cleanup checks: nothing the runner made is left.
  const sessions = (await tmux.jobSessions()).map((s) => s.name);
  const leftover = [...jobs.keys()].map(sessionName).filter((n) => sessions.includes(n));
  check(leftover.length === 0, "no tmux session left");
  check((await readdir(dirs.worktreesDir).catch(() => [])).length === 0, "no job worktree left");
  const clone = join(dirs.reposDir, OWNER, NAME);
  if (existsSync(clone)) {
    const wts = git(clone, "worktree", "list").split("\n");
    check(wts.length === 1, "git has only the clone's own worktree");
    check(!git(clone, "branch", "--list", "factory/*"), "no local run branches left");
  }
  check((await readdir(dirs.runsDir).catch(() => [])).length === 0, "no run directories left");
  for (const name of leftover) await tmux.kill(name).catch(() => {});
  if (!values.keep) await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
