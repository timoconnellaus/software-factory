// One job on the runner host, start to finish (runner-contract README, "The runner host's loop"):
//
//   job token → clone/fetch the base → adapter prepares the workspace (run branch) → session
//   → stream events → read the stage result → (build) push the run branch with a fresh job token
//   → artifacts → hand back { branch, headSha, result } → adapter release → revoke tokens → release
//
// Any channel call refused with 409 `fenced` or `killed`, or a cancel command from the heartbeat,
// stops the session at once; a fenced run hands nothing back and pushes nothing (ADR 0035).
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AdapterEvent,
  type Artifact,
  type AttachmentFile,
  artifactId,
  ChannelCallError,
  type ControlPlaneClient,
  canRun,
  type Job,
  type JobState,
  RESULT_FILE,
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

/** The session left the host's merge of the default branch with conflicts: nothing is pushed. */
class UnresolvedMerge extends Error {
  override name = "UnresolvedMerge";
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
  /** Where the session started: the base, or the host's merge of the default branch on top of it. */
  let startSha: string | undefined;
  /** Whether the branch had commits of its own before that merge. */
  let ahead = true;
  let session: S | undefined;
  let outcome: SessionOutcome = "failed";
  let summary: string | undefined;
  let error: string | undefined;
  let headSha: string | undefined;
  let result: unknown;
  let stored: StoredArtifact[] = [];
  const notes: string[] = [];

  /**
   * The work item's attachments (ADR 0310), when the adapter declares `work-item-attachments`:
   * fetched over the job channel with this job's fencing token, handed to the adapter to put
   * outside the git tree, and its note appended to the prompt. Any other runner skips this.
   */
  const withAttachments = async (j: Job, w: W): Promise<Job> => {
    const manifest = await adapter.manifest();
    if (
      !manifest.capabilities.includes("work-item-attachments") ||
      !adapter.attachFiles ||
      !cp.attachments ||
      !cp.attachment
    ) {
      return j;
    }
    const list = cp.attachments.bind(cp);
    const fetchOne = cp.attachment.bind(cp);
    let files: AttachmentFile[];
    try {
      const { attachments } = await channel(() => list(j.jobId, fence));
      if (attachments.length === 0) return j;
      files = [];
      for (const meta of attachments) {
        const got = await channel(() => fetchOne(j.jobId, fence, meta.id));
        files.push({
          meta: got.attachment,
          bytes: Uint8Array.from(Buffer.from(got.base64, "base64")),
        });
      }
    } catch (error) {
      if (error instanceof StopJob) throw error;
      // The run goes on without them; the agent is told so.
      log(
        `attachments for ${j.jobId} not fetched: ${error instanceof Error ? error.message : error}`,
      );
      notes.push("attachments could not be fetched");
      return {
        ...j,
        harness: {
          ...j.harness,
          prompt: `${j.harness.prompt}\n\n(The work item has attachments, but they could not be fetched for this run.)`,
        },
      };
    }
    const note = await adapter.attachFiles(j, w, files);
    await stream.push({
      type: "job.state",
      state: "preparing",
      detail: `${files.length} attachment(s) fetched`,
    });
    return note ? { ...j, harness: { ...j.harness, prompt: `${j.harness.prompt}\n${note}` } } : j;
  };

  const abortedOutcome = (): SessionOutcome => {
    const reason = signal.reason;
    if (reason instanceof StopJob) return "cancelled";
    return String(reason).includes("timeout") ? "timed_out" : "cancelled";
  };

  try {
    try {
      const verdict = canRun(await adapter.manifest(), job);
      if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
      await stream.push({ type: "job.state", state: "claimed" });
      if (job.stage === "build") assertPushable(job);

      await stream.push({ type: "job.state", state: "preparing", detail: "fetching the base" });
      const token = await freshToken();
      if (token.pushBranch !== job.branch) {
        throw new Error(`the job token is for ${token.pushBranch}, not ${job.branch}`);
      }
      // The checkout this machine already has for the repo (ADR 0260), else the host's own clone.
      const existing = adapter.resolveCheckout ? await adapter.resolveCheckout(job) : null;
      const clone = await git.ensureRepo(job, token.token, existing);
      if (signal.aborted) throw signal.reason;
      workspace = await adapter.prepareWorkspace(job, signal);
      if (workspace.branch !== job.branch) {
        throw new Error(`workspace is on ${workspace.branch}, not ${job.branch}`);
      }
      startSha = workspace.baseSha;
      await stream.push({
        type: "job.state",
        state: "preparing",
        detail: `${workspace.path} on ${workspace.branch} @ ${workspace.baseSha.slice(0, 7)} (${clone})`,
      });
      // A build starts from the default branch's latest too (ADR 0320): the host merges it in, so
      // the PR stays mergeable while other work lands. A conflict is left for the agent.
      if (job.stage === "build") {
        const merge = await git.mergeDefault(job, workspace.path);
        ahead = merge.ahead;
        const from = job.repo.defaultBranch;
        if (merge.status === "merged") {
          startSha = merge.sha;
          await stream.push({
            type: "job.state",
            state: "preparing",
            detail: `merged ${from} @ ${merge.sha.slice(0, 7)}`,
          });
        } else if (merge.status === "conflict") {
          await stream.push({
            type: "job.state",
            state: "preparing",
            detail: `merging ${from} conflicts in ${merge.files.length} file(s), left for the session: ${merge.files.slice(0, 20).join(", ")}`,
          });
        }
      }
      const configBefore = await git.sensitiveConfig(workspace.path);

      if (signal.aborted) throw signal.reason;
      const runJob = await withAttachments(job, workspace);
      if (signal.aborted) throw signal.reason;
      session = await adapter.startSession(runJob, workspace, signal);
      await stream.push({ type: "job.state", state: "running" });
      await stream.push({
        type: "session.started",
        sessionRef: session.sessionRef,
        ...(session.takeover ? { takeover: session.takeover } : {}),
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
      const configAfter = await git.sensitiveConfig(workspace.path);
      if (configAfter !== configBefore) {
        throw new Error(
          `the session changed the repo's git config; not pushing:\n${configAfter.slice(0, 2_000)}`,
        );
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
      // The stage result: read it, pass it through untouched, delete it. Never committed.
      const resultPath = join(workspace.path, RESULT_FILE);
      const raw = await readFile(resultPath, "utf8").catch(() => null);
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

      if (job.stage === "build" && outcome === "completed" && !error) {
        try {
          const merge = await git.mergeState(workspace.path);
          if (merge.unmerged.length > 0) {
            throw new UnresolvedMerge(
              `the merge of ${job.repo.defaultBranch ?? "the default branch"} was left unresolved in: ${merge.unmerged.slice(0, 20).join(", ")}`,
            );
          }
          if (
            await git.commitLeftovers(
              workspace.path,
              `factory: uncommitted changes left by run ${job.runNo}`,
            )
          ) {
            notes.push("the session left uncommitted changes; the runner committed them");
          }
          const head = await git.headSha(workspace.path);
          if (head === workspace.baseSha || (head === startSha && !ahead)) {
            outcome = "failed";
            notes.push("the build made no commits");
          } else {
            // A fresh token: the first one may be close to its hour by now.
            headSha = await git.pushRunBranch(job, workspace.path, await freshToken());
            await stream.push({
              type: "job.state",
              state: "collecting",
              detail: `pushed ${job.branch} @ ${headSha.slice(0, 7)}`,
            });
          }
        } catch (err) {
          if (err instanceof StopJob) throw err;
          outcome = "failed";
          if (err instanceof UnresolvedMerge) notes.push(err.message);
          else error = `push: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Collect even after a failure: a partial diff and the logs are what a person needs.
      const artifacts: Artifact[] = [];
      try {
        artifacts.push(await git.diff(workspace.path, startSha ?? workspace.baseSha, job.branch));
      } catch (err) {
        artifacts.push({ kind: "log", name: "diff-error", text: String(err) });
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
          branch: job.branch,
          ...(summary ? { summary: summary.slice(0, 20_000) } : {}),
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
    await adapter.release(job, workspace, session).catch((err) => {
      error = `${error ? `${error}; ` : ""}release: ${err instanceof Error ? err.message : err}`;
    });
    for (const token of tokens) await revokeToken(token, options.fetch);
    if (!stopped || !(stopped as StopJob).fenced) {
      await stream.push({ type: "job.state", state: "released" }).catch(() => {});
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
    ...(summary ? { summary } : {}),
    ...(headSha ? { headSha } : {}),
    ...(error ? { error } : {}),
    ...(stoppedNow && !error ? { error: stoppedNow.reason } : {}),
  };
}
