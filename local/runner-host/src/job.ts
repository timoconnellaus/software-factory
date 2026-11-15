// One job on the runner host, start to finish (runner-contract README, "The runner host's loop"). A
// job is a `flow` run (spec 70):
//
//   (with a repository) job token → clone/fetch the base → adapter prepares the workspace (a
//   worktree on the item's branch) → session → stream events → read the result → commit leftovers
//   and push the item's branch with a fresh job token when the run made commits → artifacts → hand
//   back { branch, headSha, result } → adapter release → revoke tokens → release
//
// A job without a repository skips every git step: no token, clone, branch, push or diff. The
// adapter gives it a plain directory; the rest is the same.
//
// Any channel call refused with 409 `fenced` or `killed`, or a cancel command from the heartbeat,
// stops the session at once; a fenced run hands nothing back and pushes nothing (ADR 0035).
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type AdapterEvent,
  type Artifact,
  artifactId,
  ChannelCallError,
  type ControlPlaneClient,
  canRun,
  hasRepo,
  isReleaseIncomplete,
  JOB_STAGES,
  type Job,
  type JobState,
  RESULT_FILE,
  type RepoJob,
  type RunnerAdapter,
  type RunnerEvent,
  type SessionHandle,
  type SessionOutcome,
  type StoredArtifact,
  type TokenResponse,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { assertPushable, type HostGit, revokeToken } from "./git.ts";

export interface JobReport {
  jobId: string;
  outcome: SessionOutcome;
  summary?: string;
  headSha?: string;
  artifacts: StoredArtifact[];
  handedBack: boolean;
  fenced: boolean;
  error?: string;
  /** Release couldn't confirm the job's processes stopped (ADR 0550): not reported released. */
  processesAlive?: boolean;
}

/** A stop that comes from the cloud: the run must end without handing back. */
export class StopJob extends Error {
  override name = "StopJob";
  constructor(
    readonly reason: string,
    readonly fenced: boolean,
  ) {
    super(reason);
  }
}

/** Whether a channel refusal means "stop this job now" (ADR 0035, 0044). */
export function isStop(error: unknown): error is ChannelCallError {
  return (
    error instanceof ChannelCallError &&
    error.status === 409 &&
    (error.code === "fenced" || error.code === "killed")
  );
}

const LOG_MAX = 60_000;

/** Buffers events and sends them in seq order. A failed batch is re-sent as is (same key). */
class EventStream {
  private seq = 0;
  private pending: RunnerEvent[] = [];
  private inflight: RunnerEvent[] | null = null;
  private sending: Promise<void> = Promise.resolve();
  constructor(
    private readonly job: Job,
    private readonly cp: ControlPlaneClient,
    private readonly onStop: (error: ChannelCallError) => void,
    private readonly onEvent?: (e: RunnerEvent) => void,
  ) {}

  push(event: AdapterEvent | { type: "job.state"; state: JobState; detail?: string }) {
    const clipped =
      event.type === "log" && event.text.length > LOG_MAX
        ? { ...event, text: `${event.text.slice(0, LOG_MAX)}…` }
        : event;
    const stamped = {
      ...clipped,
      jobId: this.job.jobId,
      seq: ++this.seq,
      at: new Date().toISOString(),
    } as RunnerEvent;
    this.onEvent?.(stamped);
    this.pending.push(stamped);
    // Logs batch up; everything else goes out at once so the app sees state changes live.
    if (event.type !== "log" || this.pending.length >= 50) return this.flush();
    return Promise.resolve();
  }

  /** Sends what's buffered. Network errors keep the batch for the next flush; 409s stop the job. */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.inflight || this.pending.length > 0) {
        if (!this.inflight) {
          this.inflight = this.pending.splice(0, 200);
        }
        try {
          await this.cp.events(this.job.jobId, {
            fencingToken: this.job.lease.fencingToken,
            events: this.inflight,
          });
          this.inflight = null;
        } catch (error) {
          if (isStop(error)) {
            this.inflight = null;
            this.pending = [];
            this.onStop(error);
          }
          return; // keep the batch; the next flush re-sends it with the same idempotency key
        }
      }
    });
    return this.sending;
  }
}

export interface RunJobOptions<W extends WorkspaceHandle, S extends SessionHandle> {
  adapter: RunnerAdapter<W, S>;
  cp: ControlPlaneClient;
  git: HostGit;
  job: Job;
  /** Aborted by the host for a cancel command or shutdown; its reason is the message. */
  signal?: AbortSignal;
  onEvent?: (e: RunnerEvent) => void;
  log?: (message: string) => void;
  fetch?: typeof fetch;
  /** How often buffered log events are flushed. */
  flushMs?: number;
  /** Called once the cloud has the hand-back: the job no longer holds its lease. */
  onHandedBack?: () => void;
}

/**
 * The result, only as a regular file directly in the workspace. A symlink (which the agent can
 * leave there) would let it hand any file on the host back as the result: it is refused and removed.
 */
export async function readResultFile(
  worktree: string,
  path: string,
  notes: string[],
): Promise<string | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return null;
  const root = await realpath(worktree).catch(() => worktree);
  const dir = await realpath(join(path, "..")).catch(() => null);
  if (!stat.isFile() || stat.isSymbolicLink() || !dir || relative(root, dir) !== "") {
    notes.push(`${RESULT_FILE} was not a regular file in the worktree; ignored`);
    return null;
  }
  if (stat.size > 8 << 20) {
    notes.push(`${RESULT_FILE} is over 8 MiB; ignored`);
    return null;
  }
  return readFile(path, "utf8").catch(() => null);
}

export async function runJob<W extends WorkspaceHandle, S extends SessionHandle>(
  options: RunJobOptions<W, S>,
): Promise<JobReport> {
  const { adapter, cp, git, job } = options;
  const log = options.log ?? (() => {});
  const fence = job.lease.fencingToken;
  const controller = new AbortController();
  let stopped: StopJob | null = null;
  let handedBack = false;
  const stop = (reason: string, fenced: boolean) => {
    // After the hand-back the run is over in the cloud; a late cancel ("run is handed_back") is moot.
    if (stopped || handedBack) return;
    stopped = new StopJob(reason, fenced);
    controller.abort(stopped);
  };
  const onAbort = () => {
    const reason = options.signal?.reason;
    const text = reason instanceof Error ? reason.message : String(reason ?? "cancelled");
    stop(text, /^fenced/.test(text));
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("session timeout")),
    job.limits.sessionTimeoutMs,
  );
  const signal = controller.signal;
  const stream = new EventStream(
    job,
    cp,
    (error) => stop(`${error.code}: ${error.message}`, error.code === "fenced"),
    options.onEvent,
  );
  const flusher = setInterval(() => void stream.flush(), options.flushMs ?? 3_000);
  /** Runs a channel call; a 409 fenced/killed stops the job and rethrows as StopJob. */
  const channel = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (isStop(error)) {
        stop(`${error.code}: ${error.message}`, error.code === "fenced");
        throw stopped;
      }
      throw error;
    }
  };
  const tokens: string[] = [];
  const freshToken = async (): Promise<TokenResponse> => {
    const token = await channel(() => cp.token(job.jobId, fence));
    tokens.push(token.token);
    return token;
  };

  let workspace: W | undefined;
  let session: S | undefined;
  let outcome: SessionOutcome = "failed";
  let summary: string | undefined;
  let error: string | undefined;
  let headSha: string | undefined;
  let result: unknown;
  /** The worktree's sensitive git config before the session, checked again after it. */
  let configBefore: string | undefined;
  let stored: StoredArtifact[] = [];
  const notes: string[] = [];
  const report: Pick<JobReport, "processesAlive"> = {};

  /** The job with its repository, or null for one without: every git step skips. */
  const repoJob = hasRepo(job) ? job : null;

  /** Fetches the base for a job with a repo: its token, then the checkout or the host's clone. */
  const fetchBase = async (j: RepoJob): Promise<string> => {
    assertPushable(j);
    await stream.push({ type: "job.state", state: "preparing", detail: "fetching the base" });
    const token = await freshToken();
    if (token.pushBranch !== j.branch) {
      throw new Error(`the job token is for ${token.pushBranch}, not ${j.branch}`);
    }
    // The checkout this machine already has for the repo (ADR 0260), else the host's own clone.
    const existing = adapter.resolveCheckout ? await adapter.resolveCheckout(j) : null;
    return git.ensureRepo(j, token.token, existing);
  };

  const abortedOutcome = (): SessionOutcome => {
    const reason = signal.reason;
    if (reason instanceof StopJob) return "cancelled";
    return String(reason).includes("timeout") ? "timed_out" : "cancelled";
  };

  try {
    try {
      // An engine from before this runner's code could still offer a stage it no longer runs.
      if (!(JOB_STAGES as readonly string[]).includes(job.stage)) {
        throw new Error(`refused: this runner runs no ${job.stage} jobs`);
      }
      const verdict = canRun(await adapter.manifest(), job);
      if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
      await stream.push({ type: "job.state", state: "claimed" });
      const clone = repoJob ? await fetchBase(repoJob) : null;
      if (signal.aborted) throw signal.reason;
      workspace = await adapter.prepareWorkspace(job, signal);
      if (repoJob && workspace.branch !== repoJob.branch) {
        throw new Error(`workspace is on ${workspace.branch}, not ${repoJob.branch}`);
      }
      await stream.push({
        type: "job.state",
        state: "preparing",
        detail: repoJob
          ? `${workspace.path} on ${workspace.branch} @ ${workspace.baseSha.slice(0, 7)} (${clone})`
          : `${workspace.path} (no repo)`,
      });
      if (repoJob) configBefore = await git.sensitiveConfig(workspace.path);

      if (signal.aborted) throw signal.reason;
      session = await adapter.startSession(job, workspace, signal);
      await stream.push({ type: "job.state", state: "running" });
      await stream.push({
        type: "session.started",
        sessionRef: session.sessionRef,
        ...(session.takeover ? { takeover: session.takeover } : {}),
        // How it runs (ADR 0450): a stream session also reports tool results and token counts.
        ...(session.mode ? { mode: session.mode } : {}),
      });
      for await (const event of adapter.events(job, session, signal)) {
        await stream.push(event);
        if (event.type === "session.ended") {
          outcome = event.outcome;
          summary = event.summary;
        }
      }
      if (signal.aborted && outcome !== "completed") outcome = abortedOutcome();

      // The harness must not have rewired git (a remote, a URL rewrite, a credential helper).
      if (repoJob) {
        const configAfter = await git.sensitiveConfig(workspace.path);
        if (configAfter !== configBefore) {
          throw new Error(
            `the session changed the repo's git config; not pushing:\n${configAfter.slice(0, 2_000)}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof StopJob || signal.reason instanceof StopJob) {
        outcome = "cancelled";
      } else {
        error = err instanceof Error ? err.message : String(err);
        outcome = signal.aborted ? abortedOutcome() : "failed";
      }
    } finally {
      clearTimeout(timer);
    }

    if (workspace && !stopped) {
      await stream.push({ type: "job.state", state: "collecting" });
      // The result: read it, pass it through untouched, delete it. Never committed.
      const resultPath = join(workspace.path, RESULT_FILE);
      const raw = await readResultFile(workspace.path, resultPath, notes);
      await rm(resultPath, { force: true });
      if (raw !== null) {
        try {
          result = JSON.parse(raw);
        } catch {
          notes.push(`${RESULT_FILE} was not valid JSON`);
        }
      } else if (outcome === "completed") {
        notes.push(`the session wrote no ${RESULT_FILE}`);
      }

      // With a repository: what the session left is committed, and the item's branch pushed when
      // the run made commits. A run need not change the code (a review, a question).
      if (repoJob && outcome === "completed" && !error) {
        try {
          if (
            await git.commitLeftovers(
              workspace.path,
              `factory: uncommitted changes left by run ${job.runNo}`,
            )
          ) {
            notes.push("the session left uncommitted changes; the runner committed them");
          }
          const head = await git.headSha(workspace.path);
          if (head === workspace.baseSha) {
            notes.push("the run made no commits; nothing was pushed");
          } else {
            // A fresh token: the first one may be close to its hour by now.
            headSha = await git.pushRunBranch(repoJob, workspace.path, await freshToken());
            await stream.push({
              type: "job.state",
              state: "collecting",
              detail: `pushed ${repoJob.branch} @ ${headSha.slice(0, 7)}`,
            });
          }
        } catch (err) {
          if (err instanceof StopJob) throw err;
          outcome = "failed";
          error = `push: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Collect even after a failure: a partial diff and the logs are what a person needs.
      const artifacts: Artifact[] = [];
      if (repoJob) {
        try {
          artifacts.push(await git.diff(workspace.path, workspace.baseSha, repoJob.branch));
        } catch (err) {
          artifacts.push({ kind: "log", name: "diff-error", text: String(err) });
        }
      }
      artifacts.push(
        ...(await adapter
          .collectArtifacts(job, workspace, session)
          .catch((err) => [{ kind: "log" as const, name: "collect-error", text: String(err) }])),
      );
      const fullSummary = [summary, ...notes, error].filter(Boolean).join("\n\n") || undefined;
      if (fullSummary) artifacts.push({ kind: "summary", text: fullSummary.slice(0, 20_000) });
      for (const artifact of artifacts) {
        const withId = { ...artifact, id: await artifactId(artifact), jobId: job.jobId };
        await channel(() => cp.artifact(job.jobId, fence, withId));
        stored.push(withId);
      }
      summary = fullSummary;
    }

    if (!stopped) {
      await channel(() =>
        cp.handback({
          jobId: job.jobId,
          fencingToken: fence,
          outcome,
          artifactIds: stored.map((a) => a.id),
          // A job without a repo has no branch: the hand-back's is empty.
          branch: job.branch ?? "",
          ...(summary ? { summary: summary.slice(0, 20_000) } : {}),
          ...(error ? { error: error.slice(0, 2_000) } : {}),
          ...(headSha ? { headSha } : {}),
          ...(result !== undefined ? { result } : {}),
        }),
      );
      handedBack = true;
      options.onHandedBack?.();
      await stream.push({
        type: "job.state",
        state: outcome === "completed" ? "handed_back" : "failed",
        ...(error ? { detail: error.slice(0, 2_000) } : {}),
      });
    }
  } catch (err) {
    if (!(err instanceof StopJob)) {
      error = `${error ? `${error}; ` : ""}collect/handback: ${err instanceof Error ? err.message : err}`;
    }
  } finally {
    clearTimeout(timer);
    clearInterval(flusher);
    let processesAlive = false;
    let releaseFailed = false;
    await adapter.release(job, workspace, session).catch((err) => {
      releaseFailed = true;
      error = `${error ? `${error}; ` : ""}release: ${err instanceof Error ? err.message : err}`;
      // The job's processes may still be running (ADR 0550): it is never reported released.
      if (isReleaseIncomplete(err)) processesAlive = true;
    });
    for (const token of tokens) await revokeToken(token, options.fetch);
    if (processesAlive) {
      log(`${job.jobId}: NOT released, its processes may still be running: ${error ?? ""}`);
      await stream
        .push({
          type: "log",
          stream: "stderr",
          text: `runner: the job's processes may still be running; not releasing it (the lease lapses instead): ${error ?? ""}`.slice(
            0,
            2_000,
          ),
        })
        .catch(() => {});
      await stream.flush().catch(() => {});
      report.processesAlive = true;
    } else if (!stopped || !(stopped as StopJob).fenced) {
      if (!releaseFailed) {
        await stream.push({ type: "job.state", state: "released" }).catch(() => {});
      }
      await stream.flush().catch(() => {});
      await cp
        .release({
          jobId: job.jobId,
          fencingToken: fence,
          finalState: handedBack && outcome === "completed" ? "handed_back" : "failed",
          ...(error || stopped
            ? { reason: (error ?? (stopped as StopJob | null)?.reason ?? "").slice(0, 2_000) }
            : {}),
        })
        .catch((err) => log(`release ${job.jobId}: ${err instanceof Error ? err.message : err}`));
    }
    options.signal?.removeEventListener("abort", onAbort);
  }
  stored = stored.slice();
  const stoppedNow = stopped as StopJob | null;
  return {
    jobId: job.jobId,
    outcome: stoppedNow ? "cancelled" : outcome,
    artifacts: stored,
    handedBack,
    fenced: stoppedNow?.fenced ?? false,
    ...report,
    ...(summary ? { summary } : {}),
    ...(headSha ? { headSha } : {}),
    ...(error ? { error } : {}),
    ...(stoppedNow && !error ? { error: stoppedNow.reason } : {}),
  };
}
