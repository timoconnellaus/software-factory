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
  type AttachmentMeta,
  ChannelCallError,
  type ClaimRequest,
  CONTRACT_VERSION,
  type Handback,
  type HeartbeatRequest,
  handleRunnerCall,
  httpControlPlane,
  type Job,
  memoryIdempotencyStore,
  type OpenTerminalOptions,
  PATHS,
  type PlanningRelay,
  parseJobPath,
  type RunnerAdapter,
  type RunnerCommand,
  type RunnerEvent,
  runnerChannelKey,
  type StoredArtifact,
  stagePool,
  type TerminalSize,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { nodeExec } from "@software-factory/runner-local";
import { FETCH_NAMESPACE, hostGit } from "../src/git.ts";

export const RUNNER = "r_hosttest01";

/**
 * True when this machine's git has no `--attr-source` (it came in git 2.40). The host's clean tree
 * export (`exportTree` in src/git.ts) needs it, so a test that exports a tree can't run here. That
 * is the case in a check container: the agent image's git is Debian bookworm's 2.39. Such a test is
 * skipped there, never weakened. Every runner host's own git is 2.40 or later (macOS ships 2.50).
 */
export const NO_GIT_ATTR_SOURCE = (() => {
  try {
    execFileSync("git", ["--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "version"], {
      stdio: "ignore",
    });
    return false;
  } catch {
    return true;
  }
})();

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
  /** Each job's work item attachments, as the channel serves them (ADR 0310). */
  attachments: Map<string, { meta: AttachmentMeta; base64: string }[]>;
  attachmentCalls: number;
  /** Planning calls the host relayed (ADR 0350), and how the fake cloud answers them. */
  planningCalls: { jobId: string; op: string; input: Record<string, unknown> }[];
  planning: (call: { jobId: string; op: string; input: Record<string, unknown> }) => unknown;
  /** What the heartbeat answers as `desiredVersion` (ADR 0360); undefined leaves it out. */
  desiredVersion?: string | null;
  /** What the heartbeat answers as `minRunnerCompat` (ADR 0520); undefined leaves it out. */
  minRunnerCompat?: number;
  /**
   * Hand out a queued job only when the claim's capacity has room in its pool (ADR 0301), as the
   * engine does. Off: the next queued job, whatever the capacity says.
   */
  pools?: boolean;
  /** The capacity each claim reported. */
  claimCapacities: ClaimRequest["capacity"][];
  /** Steers queued per job (ADR 0400); the steer call takes them. */
  steers: Map<
    string,
    { id: string; text: string; at: string; interrupt?: boolean; kind?: "message" | "takeover" }[]
  >;
  steerCalls: number;
  /** Answer the steer call 404, as an engine from before ADR 0400 does. */
  noSteerCall?: boolean;
  /** Web terminal socket URLs to hand out, one per terminal call (ADR 0440). */
  terminalUrls: Map<string, string[]>;
  terminalCalls: number;
  /** Answer the terminal call 404, as an engine from before ADR 0440 does. */
  noTerminalCall?: boolean;
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
    attachments: new Map(),
    attachmentCalls: 0,
    planningCalls: [],
    planning: () => ({}),
    steers: new Map(),
    steerCalls: 0,
    terminalUrls: new Map(),
    terminalCalls: 0,
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
            const fits = (j: Job) =>
              !cloud.pools ||
              (stagePool(j.stage) === "light"
                ? (capacity.light?.inUse ?? 0) < (capacity.light?.max ?? 0)
                : capacity.inUse < capacity.max);
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
          if (parsed.call === "steer" && cloud.noSteerCall) {
            cloud.steerCalls++;
            return { status: 404, body: { error: `unknown path ${path}`, code: "not_found" } };
          }
          if (parsed.call === "terminal" && cloud.noTerminalCall) {
            cloud.terminalCalls++;
            return { status: 404, body: { error: `unknown path ${path}`, code: "not_found" } };
          }
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
                  repo: { owner: job?.repo.owner, name: job?.repo.name },
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
            case "attachments":
              cloud.attachmentCalls++;
              return {
                body: { attachments: (cloud.attachments.get(jobId) ?? []).map((a) => a.meta) },
              };
            case "attachment": {
              cloud.attachmentCalls++;
              const { attachmentId } = body as { attachmentId: string };
              const found = cloud.attachments.get(jobId)?.find((a) => a.meta.id === attachmentId);
              return found
                ? { body: { attachment: found.meta, base64: found.base64 } }
                : { status: 404, body: { error: "no attachment", code: "not_found" } };
            }
            case "steer": {
              // Held briefly while nothing is queued (the real engine holds ~25 s).
              cloud.steerCalls++;
              const { waitMs = 0 } = body as { waitMs?: number };
              const until = Date.now() + Math.min(waitMs, 100);
              for (;;) {
                const queued = cloud.steers.get(jobId) ?? [];
                if (queued.length > 0 || Date.now() >= until) {
                  cloud.steers.set(jobId, []);
                  return { body: { steers: queued } };
                }
                await new Promise((r) => setTimeout(r, 10));
              }
            }
            case "terminal": {
              cloud.terminalCalls++;
              const { waitMs = 0 } = body as { waitMs?: number };
              const until = Date.now() + Math.min(waitMs, 100);
              for (;;) {
                const url = cloud.terminalUrls.get(jobId)?.shift();
                if (url || Date.now() >= until) return { body: { connect: url ? { url } : null } };
                await new Promise((r) => setTimeout(r, 10));
              }
            }
            case "planning": {
              const { op, input } = body as { op: string; input: Record<string, unknown> };
              const call = { jobId, op, input: input ?? {} };
              cloud.planningCalls.push(call);
              return { body: cloud.planning(call) as Record<string, unknown> };
            }
            case "line":
              // An engine without the job line (spec 44 part B): the host keeps its held calls.
              return { status: 404, body: { error: `unknown path ${path}`, code: "not_found" } };
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

/** A scratch "GitHub": a bare repo with main and the work item branch `factory/7-add-a-line`. */
export async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "sf-host-"));
  const seed = join(root, "seed");
  const bare = join(root, "origin.git");
  execFileSync("mkdir", ["-p", seed]);
  git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "# scratch\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  git(seed, "branch", "factory/7-add-a-line");
  git(root, "clone", "-q", "--bare", seed, bare);
  const host = hostGit({
    exec: nodeExec,
    reposDir: join(root, "repos"),
    identity: { name: "Software Factory", email: "sf@example.invalid" },
    repoUrlMap: { "https://github.com/acme/app.git": bare },
  });
  return { root, bare, host, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export function job(overrides: Partial<Job> = {}): Job {
  return {
    jobId: `job_${Math.random().toString(36).slice(2, 10)}`,
    runId: "run_1",
    runNo: 1,
    stage: "build",
    workItem: { id: "wi_1", number: 7, title: "Add a line" },
    repo: {
      url: "https://github.com/acme/app.git",
      owner: "acme",
      name: "app",
      baseRef: "factory/7-add-a-line",
    },
    branch: "factory/7-add-a-line-run-1",
    harness: { id: "claude-code", role: "implement", prompt: "add a line" },
    context: {},
    requires: [],
    limits: { sessionTimeoutMs: 30_000 },
    lease: { fencingToken: 3, expiresAt: new Date(Date.now() + 600_000).toISOString() },
    ...overrides,
  };
}

/** A terminal bridge that records what the relay asked of it (ADR 0440). */
export interface FakeTerminal {
  opened: OpenTerminalOptions[];
  writes: string[];
  resizes: TerminalSize[];
  redraws: number;
  closes: number;
  open(options: OpenTerminalOptions): Promise<{
    write(data: string): Promise<void>;
    resize(size: TerminalSize): Promise<void>;
    redraw(): Promise<void>;
    close(): Promise<void>;
  }>;
}

export function fakeTerminal(): FakeTerminal {
  const t: FakeTerminal = {
    opened: [],
    writes: [],
    resizes: [],
    redraws: 0,
    closes: 0,
    async open(options) {
      t.opened.push(options);
      options.onSize({ cols: 80, rows: 24 });
      options.onOutput(new TextEncoder().encode("screen"));
      return {
        async write(data) {
          t.writes.push(data);
        },
        async resize(size) {
          t.resizes.push(size);
          options.onSize(size);
        },
        async redraw() {
          t.redraws++;
          options.onOutput(new TextEncoder().encode("redrawn"));
        },
        async close() {
          t.closes++;
        },
      };
    },
  };
  return t;
}

/** A WebSocket the test drives: what the host sent, and messages from the "relay". */
export class FakeSocket {
  binaryType = "blob";
  bufferedAmount = 0;
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string | Uint8Array) {
    if (this.closed) throw new Error("closed");
    this.sent.push(typeof data === "string" ? data : data.slice());
  }

  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }

  /** The relay sends a control message. */
  relay(message: object) {
    this.emit("message", JSON.stringify(message));
  }

  emit(type: string, data?: unknown) {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }

  texts(): Record<string, unknown>[] {
    return this.sent.filter((s) => typeof s === "string").map((s) => JSON.parse(s as string));
  }

  bytes(): string[] {
    return this.sent
      .filter((s): s is Uint8Array => typeof s !== "string")
      .map((b) => new TextDecoder().decode(b));
  }
}

export interface FakeWorkspace extends WorkspaceHandle {
  clone: string;
}

/**
 * An adapter whose "session" is a function run in a plain git worktree of the host's clone. It
 * records what happened so tests can check the lifecycle.
 */
export function fakeAdapter(
  clonePath: (job: Job) => string,
  session: (
    worktree: string,
    job: Job,
    signal: AbortSignal,
    relay?: PlanningRelay,
  ) => Promise<AdapterEvent[]>,
  options: { steer?: boolean; interrupt?: boolean; terminal?: boolean } = {},
): RunnerAdapter<FakeWorkspace> & {
  calls: string[];
  prompts: string[];
  relays: Map<string, PlanningRelay>;
  steered: string[];
  interrupted: string[];
  terminal: FakeTerminal;
} {
  const calls: string[] = [];
  const prompts: string[] = [];
  const relays = new Map<string, PlanningRelay>();
  const steered: string[] = [];
  const interrupted: string[] = [];
  const terminal = fakeTerminal();
  return {
    calls,
    prompts,
    relays,
    steered,
    interrupted,
    terminal,
    async manifest() {
      return {
        contractVersion: CONTRACT_VERSION,
        runnerKind: "fake",
        harnesses: ["claude-code"],
        capabilities: [
          "headless",
          ...(options.steer ? (["steer"] as const) : []),
          ...(options.interrupt ? (["interrupt"] as const) : []),
          ...(options.terminal ? (["terminal"] as const) : []),
        ],
      };
    },
    ...(options.terminal
      ? { openTerminal: (_s: unknown, o: OpenTerminalOptions) => terminal.open(o) }
      : {}),
    ...(options.steer
      ? {
          async steer(_s: unknown, text: string) {
            steered.push(text);
          },
          // Another turn of the same "session" (ADR 0501): the text goes in, the session runs again.
          async *continueSession(j: Job, _s: unknown, text: string, signal: AbortSignal) {
            steered.push(text);
            const ws = join(clonePath(j), "..", `wt-${j.jobId}`);
            for (const e of await session(ws, j, signal, relays.get(j.jobId))) yield e;
          },
        }
      : {}),
    ...(options.interrupt
      ? {
          async interrupt(_s: unknown, text: string) {
            interrupted.push(text);
          },
        }
      : {}),
    async capacity() {
      return { max: 2, inUse: 0, accepting: true };
    },
    async prepareWorkspace(j, _signal, options) {
      calls.push("prepare");
      if (options?.planningRelay) relays.set(j.jobId, options.planningRelay);
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
      const ws = join(clonePath(j), "..", `wt-${j.jobId}`);
      for (const e of await session(ws, j, signal, relays.get(j.jobId))) yield e;
    },
    async collectArtifacts(): Promise<Artifact[]> {
      calls.push("collect");
      return [{ kind: "log", name: "terminal-screen", text: "done" }];
    },
    async release(_j, ws) {
      calls.push("release");
      if (ws) {
        execFileSync("git", ["worktree", "remove", "--force", ws.path], { cwd: ws.clone });
        git(ws.clone, "branch", "-D", ws.branch);
      }
    },
  };
}

export { ChannelCallError };
