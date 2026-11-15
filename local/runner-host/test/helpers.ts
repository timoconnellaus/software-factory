// Test fixtures: a cloud serving the real signed channel (handleRunnerCall + the in-memory
// idempotency store), a scratch GitHub (a local bare repo), and a fake adapter that runs a
// scripted "session" in a plain git worktree.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdapterEvent,
  type Artifact,
  ChannelCallError,
  type ClaimRequest,
  CONTRACT_VERSION,
  type Handback,
  type HeartbeatRequest,
  handleRunnerCall,
  hasRepo,
  httpControlPlane,
  type Job,
  memoryIdempotencyStore,
  PATHS,
  parseJobPath,
  type RepoJob,
  type RunnerAdapter,
  type RunnerCommand,
  type RunnerEvent,
  runnerChannelKey,
  type StoredArtifact,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { nodeExec } from "@software-factory/runner-local";
import { FETCH_NAMESPACE, hostGit } from "../src/git.ts";

export const RUNNER = "r_hosttest01";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

export interface FakeCloud {
  fetch: typeof fetch;
  queue: Job[];
  claims: Map<string, Job>;
  events: Map<string, RunnerEvent[]>;
  artifacts: Map<string, StoredArtifact>;
  handbacks: Map<string, Handback>;
  released: Map<string, { finalState: string; reason?: string }>;
  heartbeats: HeartbeatRequest[];
  commands: RunnerCommand[];
  tokens: number;
  /** Job ids whose next call is refused as fenced. */
  fenced: Set<string>;
  /** What the heartbeat answers as `desiredVersion` (ADR 0360); undefined leaves it out. */
  desiredVersion?: string | null;
  /** What the heartbeat answers as `minRunnerCompat` (ADR 0520); undefined leaves it out. */
  minRunnerCompat?: number;
  /**
   * Hand out a queued job only when the claim's capacity has room in the light pool (ADR 0301), as
   * the engine does for a flow job. Off: the next queued job, whatever the capacity says.
   */
  pools?: boolean;
  /** The capacity each claim reported. */
  claimCapacities: ClaimRequest["capacity"][];
}

export function fakeCloud(masterSecret = "test-master-secret"): FakeCloud {
  const store = memoryIdempotencyStore();
  const cloud: FakeCloud = {
    queue: [],
    claims: new Map(),
    events: new Map(),
    artifacts: new Map(),
    handbacks: new Map(),
    released: new Map(),
    heartbeats: [],
    claimCapacities: [],
    commands: [],
    tokens: 0,
    fenced: new Set(),
    fetch: async (input, init) =>
      handleRunnerCall(
        new Request(input, init),
        { keyFor: (runner) => runnerChannelKey(masterSecret, runner), store },
        async ({ path, body }) => {
          if (path === PATHS.heartbeat) {
            const hb = body as HeartbeatRequest;
            cloud.heartbeats.push(hb);
            return {
              body: {
                commands: cloud.commands.splice(0),
                ...(cloud.desiredVersion !== undefined
                  ? { desiredVersion: cloud.desiredVersion }
                  : {}),
                ...(cloud.minRunnerCompat !== undefined
                  ? { minRunnerCompat: cloud.minRunnerCompat }
                  : {}),
                leases: hb.activeJobs.map((j) => ({
                  jobId: j.jobId,
                  expiresAt: new Date(Date.now() + 600_000).toISOString(),
                })),
              },
            };
          }
          if (path === PATHS.claim) {
            const { claimId, capacity } = body as ClaimRequest;
            cloud.claimCapacities.push(capacity);
            const fits = () =>
              !cloud.pools || (capacity.light?.inUse ?? 0) < (capacity.light?.max ?? 0);
            const next = cloud.claims.has(claimId) ? -1 : cloud.queue.findIndex(fits);
            const job =
              cloud.claims.get(claimId) ??
              (next >= 0 ? cloud.queue.splice(next, 1)[0] : null) ??
              null;
            if (job) cloud.claims.set(claimId, job);
            return { body: { job } };
          }
          const parsed = parseJobPath(path);
          if (!parsed) return { status: 404, body: { error: "unknown path" } };
          const { jobId, call } = parsed;
          if (cloud.fenced.has(jobId)) {
            return { status: 409, body: { error: "stale fencing token", code: "fenced" } };
          }
          const job = [...cloud.claims.values()].find((j) => j.jobId === jobId);
          switch (call) {
            case "token":
              cloud.tokens++;
              return {
                body: {
                  token: `ghs_fake_${cloud.tokens}`,
                  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                  repo: { owner: job?.repo?.owner, name: job?.repo?.name },
                  pushBranch: job?.branch,
                },
              };
            case "events": {
              const list = cloud.events.get(jobId) ?? [];
              const seen = new Set(list.map((e) => e.seq));
              for (const e of (body as { events: RunnerEvent[] }).events) {
                if (!seen.has(e.seq)) list.push(e);
              }
              cloud.events.set(jobId, list);
              return { body: { accepted: 1 } };
            }
            case "artifacts": {
              const { artifact } = body as { artifact: StoredArtifact };
              cloud.artifacts.set(artifact.id, artifact);
              return { body: { id: artifact.id } };
            }
            case "handback":
              cloud.handbacks.set(jobId, body as Handback);
              return { body: { accepted: true, reason: null } };
            case "release":
              cloud.released.set(jobId, body as { finalState: string; reason?: string });
              return { body: { released: true } };
          }
        },
      ),
  };
  return cloud;
}

export async function controlPlane(cloud: FakeCloud) {
  return httpControlPlane({
    baseUrl: "https://factory.invalid",
    runnerId: RUNNER,
    key: await runnerChannelKey("test-master-secret", RUNNER),
    fetch: cloud.fetch,
  });
}

/** A scratch "GitHub": a bare repo with `main`. */
export async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "sf-host-"));
  const seed = join(root, "seed");
  const bare = join(root, "origin.git");
  execFileSync("mkdir", ["-p", seed]);
  git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "# scratch\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  git(root, "clone", "-q", "--bare", seed, bare);
  const host = hostGit({
    exec: nodeExec,
    reposDir: join(root, "repos"),
    identity: { name: "Software Factory", email: "sf@example.invalid" },
    repoUrlMap: { "https://github.com/acme/app.git": bare },
  });
  return { root, bare, host, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function job(overrides: Partial<RepoJob> = {}): RepoJob {
  return {
    jobId: `job_${Math.random().toString(36).slice(2, 10)}`,
    runId: "run_1",
    runNo: 1,
    stage: "flow",
    workItem: { id: "wi_1", number: 7, title: "Add a line" },
    repo: {
      url: "https://github.com/acme/app.git",
      owner: "acme",
      name: "app",
      baseRef: "main",
      defaultBranch: "main",
    },
    branch: "factory/flow-acm-7",
    harness: { id: "claude-code", role: "implement", prompt: "add a line" },
    context: {},
    requires: [],
    limits: { sessionTimeoutMs: 30_000 },
    lease: { fencingToken: 3, expiresAt: new Date(Date.now() + 600_000).toISOString() },
    ...overrides,
  };
}

export interface FakeWorkspace extends WorkspaceHandle {
  /** The host's clone the worktree hangs off; empty for a job without a repo (a plain dir). */
  clone: string;
}

/**
 * An adapter whose "session" is a function run in a plain git worktree of the host's clone (or, for
 * a job without a repo, a plain temp directory). It records what happened so tests can check the
 * lifecycle.
 */
export function fakeAdapter(
  clonePath: (job: RepoJob) => string,
  session: (worktree: string, job: Job, signal: AbortSignal) => Promise<AdapterEvent[]>,
): RunnerAdapter<FakeWorkspace> & {
  calls: string[];
  prompts: string[];
} {
  const calls: string[] = [];
  const prompts: string[] = [];
  /** Each job's workspace path, as prepareWorkspace made it. */
  const paths = new Map<string, string>();
  const pathOf = (j: Job) =>
    paths.get(j.jobId) ?? (hasRepo(j) ? join(clonePath(j), "..", `wt-${j.jobId}`) : "");
  return {
    calls,
    prompts,
    async manifest() {
      return {
        contractVersion: CONTRACT_VERSION,
        runnerKind: "fake",
        harnesses: ["claude-code"],
        capabilities: ["hooks"],
      };
    },
    async capacity() {
      return { max: 2, inUse: 0, accepting: true };
    },
    async prepareWorkspace(j) {
      calls.push("prepare");
      if (!hasRepo(j)) {
        const path = await mkdtemp(join(tmpdir(), "sf-fake-flow-"));
        paths.set(j.jobId, path);
        return { jobId: j.jobId, path, branch: "", baseSha: "", clone: "" };
      }
      const clone = clonePath(j);
      const path = join(clone, "..", `wt-${j.jobId}`);
      git(
        clone,
        "worktree",
        "add",
        "-q",
        "-b",
        j.branch,
        path,
        `${FETCH_NAMESPACE}/${j.repo.baseRef}`,
      );
      return {
        jobId: j.jobId,
        path,
        branch: j.branch,
        baseSha: git(path, "rev-parse", "HEAD"),
        clone,
      };
    },
    async startSession(j) {
      calls.push("start");
      prompts.push(j.harness.prompt);
      return { jobId: j.jobId, sessionRef: "fake" };
    },
    async *events(j, _s, signal) {
      calls.push("events");
      for (const e of await session(pathOf(j), j, signal)) yield e;
    },
    async collectArtifacts(): Promise<Artifact[]> {
      calls.push("collect");
      return [{ kind: "log", name: "terminal-screen", text: "done" }];
    },
    async release(_j, ws) {
      calls.push("release");
      if (ws && !ws.clone) {
        await rm(ws.path, { recursive: true, force: true });
      } else if (ws) {
        execFileSync("git", ["worktree", "remove", "--force", ws.path], { cwd: ws.clone });
        git(ws.clone, "branch", "-D", ws.branch);
      }
    },
  };
}

export { ChannelCallError };
