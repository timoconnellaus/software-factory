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
import { setTimeout as sleep } from "node:timers/promises";
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
  STEER_WAIT_MAX_MS,
  type StoredArtifact,
  steerText,
  type TokenResponse,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { assertPushable, type HostGit, revokeToken } from "./git.ts";
import { type RunningRelay, startPlanningRelay } from "./planning-relay.ts";
import { type Connect, terminalLoop } from "./terminal.ts";

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

/**
 * A planning session gave up its slot (ADR 0301, 0350): the host ends the harness and hands back,
 * and a later answer resumes the same conversation on this runner.
 */
export class PlanningYielded extends Error {
  override name = "PlanningYielded";
  constructor() {
    super("the planning session yielded its slot");
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

/**
 * The run's steers (spec 31, ADR 0400): while the session runs, keep the channel's held `steer`
 * call open and type each message the runner's owner sends from the dashboard. Only for an adapter
 * that declares `steer` and has `steer()`. A 404 (an engine from before ADR 0400) or a run the
 * cloud no longer runs ends the loop; `fenced`/`killed` stops the job; anything else backs off.
 */
export async function steerLoop(options: {
  adapter: RunnerAdapter<WorkspaceHandle, SessionHandle>;
  cp: ControlPlaneClient;
  job: Job;
  signal: AbortSignal;
  steer: (text: string) => Promise<void>;
  /** Stop the current step, then submit the line (ADR 0470); absent when the adapter can't. */
  interrupt?: (text: string) => Promise<void>;
  /**
   * Stops the stream session for a person (ADR 0450): a `takeover` row from `run.takeover`. The
   * adapter's events then report the resume command and follow the resumed session.
   */
  takeover?: () => Promise<void>;
  push: (event: AdapterEvent) => Promise<void>;
  onStop: (error: ChannelCallError) => void;
  log: (message: string) => void;
  /** First back-off after a failed call (default 5 s). */
  retryMs?: number;
}): Promise<void> {
  const { adapter, cp, job, signal, log } = options;
  if (!adapter.steer || !cp.steers) return;
  if (!(await adapter.manifest()).capabilities.includes("steer")) return;
  const take = cp.steers.bind(cp);
  let failures = 0;
  while (!signal.aborted) {
    let steers: {
      id: string;
      text: string;
      interrupt?: boolean;
      kind?: "message" | "takeover";
    }[];
    try {
      ({ steers } = await take(
        job.jobId,
        { fencingToken: job.lease.fencingToken, waitMs: STEER_WAIT_MAX_MS },
        signal,
      ));
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (isStop(error)) {
        options.onStop(error);
        return;
      }
      if (error instanceof ChannelCallError && (error.status === 404 || error.status === 409)) {
        log(`${job.jobId}: no steers (${error.status} ${error.code ?? ""}); not asking again`);
        return;
      }
      failures++;
      const wait = Math.min((options.retryMs ?? 5_000) * 2 ** (failures - 1), 60_000);
      await sleep(wait, undefined, { signal }).catch(() => {});
      continue;
    }
    for (const s of steers) {
      if (signal.aborted) return;
      if (s.kind === "takeover") {
        try {
          if (!options.takeover) throw new Error("this session can't be taken over from here");
          await options.takeover();
          log(`${job.jobId}: stopped the session for a takeover (${s.id})`);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          await options
            .push({
              type: "log",
              stream: "stderr",
              text: `the session could not be handed over: ${why}`.slice(0, 2_000),
            })
            .catch(() => {});
        }
        continue;
      }
      const text = steerText(s.text);
      if (!text) continue;
      try {
        if (s.interrupt && options.interrupt) {
          await options.interrupt(text);
          log(`${job.jobId}: interrupted the agent for a person (${s.id})`);
        } else {
          await options.steer(text);
          log(`${job.jobId}: typed a message from the dashboard (${s.id})`);
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        await options
          .push({
            type: "log",
            stream: "stderr",
            text: `a message from the dashboard could not be typed: ${why}`.slice(0, 2_000),
          })
          .catch(() => {});
      }
    }
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
  /** How the web terminal's socket is opened (default Node's WebSocket; tests use a fake). */
  connectTerminal?: Connect;
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
  let steering: Promise<void> = Promise.resolve();
  let terminal: Promise<void> = Promise.resolve();
  const steerStop = new AbortController();
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

  const planning = job.stage === "planning";
  let relay: RunningRelay | undefined;
  let yielded = false;
  const abortedOutcome = (): SessionOutcome => {
    const reason = signal.reason;
    if (reason instanceof PlanningYielded) return "completed";
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
      // A planning session reaches its planning operations through the host's relay (ADR 0350).
      if (planning) {
        relay = await startPlanningRelay(job, cp, {
          onYield: () => {
            if (yielded || stopped) return;
            yielded = true;
            log(`${job.jobId}: the planning session yielded its slot`);
            controller.abort(new PlanningYielded());
          },
          onStop: (error) => stop(`${error.code}: ${error.message}`, error.code === "fenced"),
          log,
        });
      }
      workspace = await adapter.prepareWorkspace(
        job,
        signal,
        relay ? { planningRelay: { url: relay.url, token: relay.token } } : undefined,
      );
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
        // How it runs (ADR 0450): the dashboard shows a stream session as a chat.
        ...(session.mode ? { mode: session.mode } : {}),
      });
      // A person's messages from the dashboard, typed into the session while it runs (ADR 0400).
      const live = session;
      steering = steerLoop({
        adapter,
        cp,
        job,
        signal: AbortSignal.any([signal, steerStop.signal]),
        steer: (text) => (adapter.steer as NonNullable<typeof adapter.steer>)(live, text),
        ...(adapter.interrupt
          ? {
              interrupt: (text: string) =>
                (adapter.interrupt as NonNullable<typeof adapter.interrupt>)(live, text),
            }
          : {}),
        ...(adapter.takeover
          ? { takeover: () => (adapter.takeover as NonNullable<typeof adapter.takeover>)(live) }
          : {}),
        push: (event) => stream.push(event),
        onStop: (error) => stop(`${error.code}: ${error.message}`, error.code === "fenced"),
        log,
      });
      // The dashboard's web terminal, relayed while someone watches (ADR 0440).
      terminal = terminalLoop({
        adapter,
        cp,
        job,
        open: (o) => (adapter.openTerminal as NonNullable<typeof adapter.openTerminal>)(live, o),
        signal: AbortSignal.any([signal, steerStop.signal]),
        onStop: (error) => stop(`${error.code}: ${error.message}`, error.code === "fenced"),
        log,
        ...(options.connectTerminal ? { connect: options.connectTerminal } : {}),
      });
      try {
        for await (const event of adapter.events(job, session, signal)) {
          await stream.push(event);
          if (event.type === "session.ended") {
            outcome = event.outcome;
            summary = event.summary;
          }
        }
      } finally {
        steerStop.abort();
        await steering.catch(() => {});
        await terminal.catch(() => {});
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
      if (signal.reason instanceof PlanningYielded) {
        outcome = "completed";
      } else if (err instanceof StopJob || signal.reason instanceof StopJob) {
        outcome = "cancelled";
      } else {
        error = err instanceof Error ? err.message : String(err);
        outcome = signal.aborted ? abortedOutcome() : "failed";
      }
    } finally {
      clearTimeout(timer);
    }

    if (yielded) outcome = "completed";
    if (workspace && !stopped) {
      await stream.push({ type: "job.state", state: "collecting" });
      // The stage result: read it, pass it through untouched, delete it. Never committed. A
      // planning session has none: its record is in the factory (ADR 0300).
      const resultPath = join(workspace.path, RESULT_FILE);
      const raw = planning ? null : await readFile(resultPath, "utf8").catch(() => null);
      await rm(resultPath, { force: true });
      if (planning) {
        result = { planning: yielded ? "yielded" : "stopped" };
      } else if (raw !== null) {
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
      if (!planning) {
        try {
          artifacts.push(await git.diff(workspace.path, startSha ?? workspace.baseSha, job.branch));
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
    await relay?.close().catch(() => {});
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
