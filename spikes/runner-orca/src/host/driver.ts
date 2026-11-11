// The generic runner host: claims jobs over the channel and drives any RunnerAdapter through the
// lifecycle. It knows nothing about Orca or any other runner; that is the point of the spike.

import { artifactId, type ControlPlaneClient, type RunnerCommand } from "../contract/protocol.ts";
import {
  type AdapterEvent,
  canRun,
  type Job,
  type JobState,
  type RunnerAdapter,
  type RunnerEvent,
  type SessionHandle,
  type SessionOutcome,
  type StoredArtifact,
  type WorkspaceHandle,
} from "../contract/types.ts";

export interface JobResult {
  jobId: string;
  outcome: SessionOutcome;
  summary?: string;
  artifacts: StoredArtifact[];
  error?: string;
}

/** Buffers events and sends them in seq order, a batch at a time. */
class EventStream {
  private seq = 0;
  private pending: RunnerEvent[] = [];
  private readonly jobId: string;
  private readonly cp: ControlPlaneClient;
  private readonly onEvent: ((e: RunnerEvent) => void) | undefined;
  constructor(jobId: string, cp: ControlPlaneClient, onEvent?: (e: RunnerEvent) => void) {
    this.jobId = jobId;
    this.cp = cp;
    this.onEvent = onEvent;
  }
  async push(event: AdapterEvent | { type: "job.state"; state: JobState; detail?: string }) {
    const stamped = {
      ...event,
      jobId: this.jobId,
      seq: ++this.seq,
      at: new Date().toISOString(),
    } as RunnerEvent;
    this.onEvent?.(stamped);
    this.pending.push(stamped);
    // Logs batch up; state changes go out at once so the dashboard sees them live.
    if (event.type !== "log" || this.pending.length >= 50) await this.flush();
  }
  async flush() {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    await this.cp.events(this.jobId, batch);
  }
}

export async function runJob<W extends WorkspaceHandle, S extends SessionHandle>(
  adapter: RunnerAdapter<W, S>,
  job: Job,
  cp: ControlPlaneClient,
  options: { signal?: AbortSignal; onEvent?: (e: RunnerEvent) => void } = {},
): Promise<JobResult> {
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason));
  const timer = setTimeout(
    () => controller.abort(new Error("session timeout")),
    job.limits.sessionTimeoutMs,
  );
  const signal = controller.signal;
  const stream = new EventStream(job.jobId, cp, options.onEvent);

  let workspace: W | undefined;
  let session: S | undefined;
  let outcome: SessionOutcome = "failed";
  let summary: string | undefined;
  let error: string | undefined;
  let stored: StoredArtifact[] = [];

  try {
    const verdict = canRun(await adapter.manifest(), job);
    if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
    await stream.push({ type: "job.state", state: "claimed" });

    await stream.push({ type: "job.state", state: "preparing" });
    workspace = await adapter.prepareWorkspace(job, signal);
    await stream.push({
      type: "job.state",
      state: "preparing",
      detail: `${workspace.path} on ${workspace.branch} @ ${workspace.baseSha.slice(0, 7)}`,
    });

    session = await adapter.startSession(job, workspace, signal);
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
    if (signal.aborted && outcome === "failed") {
      outcome = String(signal.reason).includes("timeout") ? "timed_out" : "cancelled";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    outcome = signal.aborted
      ? String(signal.reason).includes("timeout")
        ? "timed_out"
        : "cancelled"
      : "failed";
  } finally {
    clearTimeout(timer);
  }

  try {
    // Collect even after a failure: a partial diff and the logs are what a person needs.
    if (workspace) {
      await stream.push({ type: "job.state", state: "collecting" });
      const artifacts = await adapter.collectArtifacts(job, workspace, session);
      if (summary) artifacts.push({ kind: "summary", text: summary });
      stored = await Promise.all(
        artifacts.map(async (a) => ({ ...a, id: await artifactId(a), jobId: job.jobId })),
      );
      await cp.artifacts(job.jobId, stored);
    }
    const handback = {
      jobId: job.jobId,
      outcome,
      artifactIds: stored.map((a) => a.id),
      ...(summary ? { summary } : {}),
      ...(workspace ? { branch: workspace.branch } : {}),
    };
    await cp.handback(handback);
    await stream.push({
      type: "job.state",
      state: outcome === "completed" ? "handed_back" : "failed",
      ...(error ? { detail: error } : {}),
    });
  } catch (err) {
    error = `${error ? `${error}; ` : ""}collect/handback: ${err instanceof Error ? err.message : err}`;
  } finally {
    await adapter.release(job, workspace, session).catch((err) => {
      error = `${error ? `${error}; ` : ""}release: ${err instanceof Error ? err.message : err}`;
    });
    await stream.push({ type: "job.state", state: "released" }).catch(() => {});
    await stream.flush().catch(() => {});
    await cp
      .release({
        jobId: job.jobId,
        finalState: outcome === "completed" ? "handed_back" : "failed",
        ...(error ? { reason: error } : {}),
      })
      .catch(() => {});
  }

  return {
    jobId: job.jobId,
    outcome,
    artifacts: stored,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * One turn of the host loop: report in, act on commands, claim if there's room, run the job.
 * The real daemon (local/runner-host) runs this on a timer and runs jobs concurrently up to
 * capacity; the spike runs one.
 */
export async function hostTick<W extends WorkspaceHandle, S extends SessionHandle>(
  adapter: RunnerAdapter<W, S>,
  cp: ControlPlaneClient,
  state: { running: Map<string, AbortController> },
  options: { onEvent?: (e: RunnerEvent) => void; onCommand?: (c: RunnerCommand) => void } = {},
): Promise<JobResult | null> {
  const manifest = await adapter.manifest();
  const capacity = await adapter.capacity();
  const { commands } = await cp.heartbeat({
    manifest,
    capacity,
    activeJobIds: [...state.running.keys()],
  });
  for (const command of commands) {
    options.onCommand?.(command);
    if (command.kind === "cancel")
      state.running.get(command.jobId)?.abort(new Error(command.reason));
  }
  if (!capacity.accepting || capacity.inUse >= capacity.max) return null;

  const { job } = await cp.claim({ claimId: crypto.randomUUID(), capacity, manifest });
  if (!job) return null;
  const controller = new AbortController();
  state.running.set(job.jobId, controller);
  try {
    return await runJob(adapter, job, cp, {
      signal: controller.signal,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
  } finally {
    state.running.delete(job.jobId);
  }
}
