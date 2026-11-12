// The runner host daemon (ADR 0014, 0016, 0100). Outbound only: every ~20 s it heartbeats (manifest,
// capacity, the jobs it holds with their fencing tokens, which renews their leases), applies the
// commands that come back (cancel, drain, account.use: ADR 0410), and claims jobs while it has
// room. Each job runs concurrently through `runJob`, which also takes the dashboard's steers for its
// session on a held channel call (ADR 0400). Nothing here knows which runner adapter it drives.
import { setTimeout as sleep } from "node:timers/promises";
import {
  type CapacityPaused,
  ChannelCallError,
  type ControlPlaneClient,
  type Job,
  RUNNER_COMPAT,
  type RunnerAccounts,
  type RunnerAdapter,
  type RunnerEvent,
  type SessionHandle,
  stagePool,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import { hostManifest } from "./checks.ts";
import type { HostGit } from "./git.ts";
import { type JobReport, type RunJobOptions, runJob } from "./job.ts";
import { writeLiveJobs } from "./live-jobs.ts";
import type { SelfUpdate, UpdateDecision } from "./self-update.ts";

export interface HostOptions<W extends WorkspaceHandle, S extends SessionHandle> {
  adapter: RunnerAdapter<W, S>;
  cp: ControlPlaneClient;
  git: HostGit;
  /** Concurrent heavy jobs (build, verify). The adapter's own `capacity().max` caps it too. */
  maxConcurrent: number;
  /**
   * Concurrent light jobs (triage, spec, planning), ADR 0301. An idle planning session holds one.
   * Default 6.
   */
  maxLight?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
  onEvent?: (e: RunnerEvent) => void;
  onJobDone?: (report: JobReport) => void;
  fetch?: typeof fetch;
  /**
   * The OS-sandboxed exec for the project's checks when the adapter has none (ADR 0501,
   * ./check-sandbox.ts). Absent or null: checks are reported not run.
   */
  checkSandbox?: RunJobOptions<W, S>["checkSandbox"];
  /** Where the jobs' check trees go (the runner's `paths().checksDir`, which harnesses deny). */
  checksDir?: string;
  /**
   * At most this many of the project's checks run at once on this runner (fifth review; default 1).
   * Each counts as a heavy job while it runs, and one waits to start while the load backoff has
   * stopped heavy work (for up to `checkLoadWaitMs`, default 10 min, then it runs anyway).
   */
  maxChecks?: number;
  checkLoadWaitMs?: number;
  /** How often a waiting check looks again (default 5 s; tests shorten it). */
  checkPollMs?: number;
  /** The disk bound for a check's tree carried to the next check (runner.json `checks.maxTreeGb`). */
  maxTreeBytes?: number;
  /** Tidies up after a crash: jobs this adapter still holds that the host isn't running. */
  reapOrphans?: (running: Set<string>) => Promise<string[]>;
  /**
   * A sweep while the host runs (a sprites runner's: sandboxes no live job holds, or past their
   * lifetime, ADR 0480), every `sweepMs` (default 10 min). Failures are logged loudly, not hidden.
   */
  sweep?: (running: Set<string>) => Promise<string[]>;
  sweepMs?: number;
  /** Runs once at start, after `reapOrphans` and before the first claim (the repo migration). */
  onStart?: () => Promise<void>;
  /** Where the host records the jobs it is running, for `sf-runner status` and `doctor`. */
  liveJobsFile?: string;
  /**
   * The runner's self-update (ADR 0360, 0520). Its report rides on every heartbeat; after each one
   * it decides whether to claim as usual (an update waits for the first idle heartbeat), claim light
   * jobs only, claim nothing, or restart. The host never runs git for it and never cancels a job for
   * it.
   */
  selfUpdate?: SelfUpdate;
  /** This code's RUNNER_COMPAT (ADR 0520); tests override it. */
  compat?: number;
  /**
   * Called once the host has stopped after an update (no jobs running), so the process exits
   * non-zero and the service (launchd or systemd) starts the new code.
   */
  onUpdated?: () => void;
  /**
   * The host's Claude accounts (ADR 0410): reported on every heartbeat (names only), and switched
   * when the owner picks one in the dashboard (`account.use`).
   */
  accounts?: {
    report(): Promise<RunnerAccounts>;
    use(name: string): Promise<void>;
  };
  /**
   * Back off claiming under load (ADR 0552): which pools take nothing new for now (`LoadGate`).
   * Reported on the heartbeat as `capacity.paused`.
   */
  load?: { check(): CapacityPaused | null };
}

interface Running {
  job: Job;
  /** Handed back: the lease is gone, so the heartbeat no longer reports it. */
  handedBack: boolean;
  controller: AbortController;
  done: Promise<JobReport>;
}

export class RunnerHost<W extends WorkspaceHandle, S extends SessionHandle> {
  private readonly running = new Map<string, Running>();
  /** The project's checks running now, across jobs (fifth review). */
  private checksRunning = 0;
  private draining = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  /** A claim whose answer never arrived is retried with the same id (same job back). */
  private pendingClaimId: string | null = null;
  private failures = 0;
  /** The first successful heartbeat since start confirms a pending update. */
  private confirmed = false;
  /** A pending update has waited past its first cap: report the heavy pool full (ADR 0520). */
  private heavyClosed = false;
  /** Whether it has logged claiming nothing for the engine's `minRunnerCompat` (once per spell). */
  private loggedIncompatible = false;
  readonly log: (message: string) => void;

  constructor(private readonly options: HostOptions<W, S>) {
    this.log = options.log ?? ((m) => console.log(`[runner] ${m}`));
  }

  get activeJobs(): string[] {
    return [...this.running.keys()];
  }

  /** Starts the loop. Resolves once the first tick is done. */
  async start(): Promise<void> {
    if (this.options.reapOrphans) {
      const reaped = await this.options.reapOrphans(new Set()).catch((err) => {
        this.log(`reap: ${err instanceof Error ? err.message : err}`);
        return [];
      });
      if (reaped.length) this.log(`cleaned up after a previous run: ${reaped.join(", ")}`);
    }
    if (this.options.sweep) {
      const sweep = this.options.sweep;
      this.sweeper = setInterval(
        () => {
          void sweep(new Set(this.running.keys())).then(
            (swept) => {
              if (swept.length) this.log(`sweep: removed ${swept.join(", ")}`);
            },
            (err) => {
              this.log(
                `SWEEP FAILED, sandboxes may still be running and billed: ${err instanceof Error ? err.message : err}`,
              );
            },
          );
        },
        this.options.sweepMs ?? 10 * 60_000,
      );
      this.sweeper.unref?.();
    }
    await this.recordLive();
    await this.options.onStart?.().catch((err) => {
      this.log(`startup: ${err instanceof Error ? err.message : err}`);
    });
    await this.tick();
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** One turn: heartbeat, commands, claims. Never overlaps itself. */
  tick(): Promise<void> {
    this.ticking ??= this.turn().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async turn(): Promise<void> {
    const every = this.options.heartbeatMs ?? 20_000;
    try {
      // The host runs the project's checks itself (ADR 0501): it declares `checks` for any adapter.
      const manifest = hostManifest(await this.options.adapter.manifest());
      const capacity = await this.capacity();
      const selfUpdate = this.options.selfUpdate;
      // A registry that can't be read is reported as nothing rather than failing the heartbeat.
      const accounts = await this.options.accounts?.report().catch((err) => {
        this.log(`accounts: ${err instanceof Error ? err.message : err}`);
        return undefined;
      });
      const { commands, leases, desiredVersion, minRunnerCompat } = await this.options.cp.heartbeat(
        {
          manifest,
          capacity,
          activeJobs: [...this.running.values()]
            .filter((r) => !r.handedBack)
            .map((r) => ({
              jobId: r.job.jobId,
              fencingToken: r.job.lease.fencingToken,
            })),
          rateLimitedUntil: null,
          ...(selfUpdate ? { version: selfUpdate.report() } : {}),
          ...(accounts ? { accounts } : {}),
          compat: this.compat,
        },
      );
      this.failures = 0;
      if (selfUpdate && !this.confirmed) {
        this.confirmed = true;
        await selfUpdate.confirm().catch((err) => {
          this.log(`self-update confirm: ${err instanceof Error ? err.message : err}`);
        });
      }
      for (const lease of leases) {
        const r = this.running.get(lease.jobId);
        if (r) r.job.lease.expiresAt = lease.expiresAt;
      }
      for (const command of commands) {
        if (command.kind === "cancel") {
          const r = this.running.get(command.jobId);
          if (r && !r.handedBack) {
            this.log(`cancel ${command.jobId}: ${command.reason}`);
            r.controller.abort(new Error(command.reason));
          }
        } else if (command.kind === "drain") {
          this.log("drain: taking no new jobs");
          this.draining = true;
        } else if (command.kind === "account.use" && this.options.accounts) {
          // The owner's pick from the dashboard (ADR 0410): new jobs use it, running ones keep
          // theirs. The next heartbeat reports it active, which settles the pick.
          await this.options.accounts.use(command.name).then(
            () => this.log(`account: new jobs use "${command.name}" (picked in the dashboard)`),
            (err) =>
              this.log(`account.use ${command.name}: ${err instanceof Error ? err.message : err}`),
          );
        }
      }
      // What to claim this turn (ADR 0520). A pending update doesn't stop claims: it goes ahead at
      // the first heartbeat with no job running. Past its first cap the host takes light jobs only,
      // past the second nothing, and an engine that needs a newer runner gets nothing at once.
      let decision: UpdateDecision = "claim";
      if (selfUpdate && !this.stopped) {
        decision = await selfUpdate.consider(
          desiredVersion ?? null,
          this.running.size === 0,
          minRunnerCompat ?? null,
        );
        // Not while draining: the restarted process wouldn't be, and would claim again before
        // whoever drained it (the desktop app, a drain command) stops it.
        if (decision === "restart" && !this.draining) {
          await this.stopForUpdate();
          return;
        }
      } else if (typeof minRunnerCompat === "number" && minRunnerCompat > this.compat) {
        // No self-update (not a git checkout): still never claim on code the engine can't serve.
        if (!this.loggedIncompatible) {
          this.log(
            `the engine needs runner compat ${minRunnerCompat}, this code is ${this.compat}: claiming nothing until it is updated`,
          );
        }
        this.loggedIncompatible = true;
        decision = "drain";
      }
      if (decision !== "drain") this.loggedIncompatible = false;
      this.heavyClosed = decision === "light";
      if (decision === "drain") {
        this.schedule(every);
        return;
      }
      while (!this.stopped && !this.draining) {
        const room = await this.capacity();
        const light = room.light ?? { max: 0, inUse: 0 };
        const paused = room.paused?.pools ?? [];
        const heavyFull = room.inUse >= room.max || paused.includes("heavy");
        const lightFull = light.inUse >= light.max || paused.includes("light");
        if (!room.accepting || (heavyFull && lightFull)) break;
        this.pendingClaimId ??= crypto.randomUUID();
        const { job } = await this.options.cp.claim({
          claimId: this.pendingClaimId,
          capacity: room,
          manifest,
        });
        this.pendingClaimId = null;
        if (!job) break;
        if (this.running.has(job.jobId)) break; // a replayed claim of a job we already run
        this.launch(job);
      }
    } catch (err) {
      // A refused claim (as opposed to a lost answer) gets a fresh id next time.
      if (err instanceof ChannelCallError) this.pendingClaimId = null;
      this.failures++;
      this.log(
        `heartbeat/claim failed (${this.failures}): ${err instanceof Error ? err.message : err}`,
      );
    }
    // Back off on repeated failures, up to 5 minutes.
    this.schedule(this.failures ? Math.min(every * 2 ** (this.failures - 1), 300_000) : every);
  }

  /** Updated and idle: stop the loop and let the process exit for the service to restart it. */
  private async stopForUpdate() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.log("updated: stopping so the new code starts");
    await this.recordLive();
    // After this turn has finished, so `stop()` from the callback doesn't wait on it.
    setImmediate(() => this.options.onUpdated?.());
  }

  private get compat(): number {
    return this.options.compat ?? RUNNER_COMPAT;
  }

  /**
   * A slot for one check (fifth review): waits while `maxChecks` are running, and while the load
   * backoff has stopped heavy work (up to `checkLoadWaitMs`, then it runs anyway, so a check can't
   * wait forever on load the factory doesn't cause). Returns the release.
   */
  private async checkSlot(jobId: string, signal: AbortSignal): Promise<() => void> {
    const max = this.options.maxChecks ?? 1;
    const loadUntil = Date.now() + (this.options.checkLoadWaitMs ?? 10 * 60_000);
    let said = "";
    for (;;) {
      signal.throwIfAborted();
      const full = this.checksRunning >= max;
      const loaded =
        !full &&
        Date.now() < loadUntil &&
        (this.options.load?.check()?.pools.includes("heavy") ?? false);
      if (!full && !loaded) break;
      const why = full ? `${this.checksRunning} check(s) running` : "the machine is overloaded";
      if (why !== said) this.log(`${jobId}: a check waits to start (${why})`);
      said = why;
      await sleep(this.options.checkPollMs ?? 5_000, undefined, { signal });
    }
    this.checksRunning++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.checksRunning--;
    };
  }

  /**
   * Both pools (ADR 0301): `max`/`inUse` are the heavy pool, `light` the light one. While a pending
   * update takes light jobs only (ADR 0520), the heavy pool reports full, so the engine sends none.
   */
  private async capacity() {
    const reported = await this.options.adapter.capacity().catch(() => null);
    const running = [...this.running.values()];
    const lightInUse = running.filter((r) => stagePool(r.job.stage) === "light").length;
    // A running check is heavy work of its own (2 CPUs, 4 GB by default): it counts as a heavy job.
    const heavyInUse = running.length - lightInUse + this.checksRunning;
    // The adapter may see workspaces the host doesn't run (a crashed run): count them as heavy.
    const inUse = Math.max(heavyInUse, (reported?.inUse ?? 0) - lightInUse);
    const open = Math.min(this.options.maxConcurrent, reported?.max ?? this.options.maxConcurrent);
    // Why it takes nothing new (ADR 0552): a drain first, then the adapter's own pause (its tmux
    // not answering), else the load's.
    const paused: CapacityPaused | undefined = this.draining
      ? { reason: "draining", pools: ["heavy", "light"] }
      : (reported?.paused ?? this.options.load?.check() ?? undefined);
    // A paused heavy pool also reports full, as a closed one does (ADR 0520), so an engine that
    // doesn't read `paused` sends no heavy job either.
    const max = this.heavyClosed || paused?.pools.includes("heavy") ? Math.min(open, inUse) : open;
    return {
      max,
      inUse,
      accepting:
        !this.draining &&
        !this.stopped &&
        (reported?.accepting ?? true) &&
        (paused?.pools.length ?? 0) < 2,
      light: { max: this.options.maxLight ?? 6, inUse: lightInUse },
      ...(paused ? { paused } : {}),
    };
  }

  private launch(job: Job) {
    const controller = new AbortController();
    const entry: Running = {
      job,
      controller,
      handedBack: false,
      done: Promise.resolve(null as unknown as JobReport),
    };
    this.log(`claimed ${job.jobId}: ${job.stage} for #${job.workItem.number} on ${job.branch}`);
    const done = runJob({
      adapter: this.options.adapter,
      cp: this.options.cp,
      git: this.options.git,
      job,
      signal: controller.signal,
      log: this.log,
      onHandedBack: () => {
        entry.handedBack = true;
      },
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.checkSandbox ? { checkSandbox: this.options.checkSandbox } : {}),
      ...(this.options.checksDir ? { checksDir: this.options.checksDir } : {}),
      checkSlot: (signal) => this.checkSlot(job.jobId, signal),
      ...(this.options.maxTreeBytes ? { maxTreeBytes: this.options.maxTreeBytes } : {}),
    })
      .then((report) => {
        this.log(
          `${job.jobId} ${report.outcome}${report.handedBack ? ", handed back" : ""}${report.headSha ? ` @ ${report.headSha.slice(0, 7)}` : ""}${report.error ? ` (${report.error.slice(0, 300)})` : ""}`,
        );
        this.options.onJobDone?.(report);
        return report;
      })
      .finally(() => {
        this.running.delete(job.jobId);
        void this.recordLive();
        // A slot came free: look for the next job now rather than at the next heartbeat.
        if (!this.stopped) this.schedule(1_000);
      });
    entry.done = done;
    this.running.set(job.jobId, entry);
    void this.recordLive();
  }

  private async recordLive() {
    if (!this.options.liveJobsFile) return;
    await writeLiveJobs(this.options.liveJobsFile, this.activeJobs).catch((err) => {
      this.log(`live jobs file: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Stops claiming, locally (the desktop app's "Restart to update", spec 40 M4), and rewrites the
   * live-jobs file once any claim in flight has landed, so a reader that sees the new `updatedAt`
   * knows the job list is final. Running jobs carry on.
   */
  async drain(): Promise<void> {
    if (!this.draining) this.log("drain: taking no new jobs (asked locally)");
    this.draining = true;
    await this.ticking;
    await this.recordLive();
  }

  /** Waits for every running job to finish. */
  async idle(): Promise<JobReport[]> {
    return Promise.all([...this.running.values()].map((r) => r.done));
  }

  /**
   * Stops claiming. With `cancel`, running jobs are stopped (they release their workspaces and
   * report failed, so the Workflow retries them elsewhere); otherwise they finish first.
   */
  async stop(options: { cancel?: boolean; timeoutMs?: number } = {}): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    if (options.cancel) {
      for (const r of this.running.values())
        r.controller.abort(new Error("the runner is stopping"));
    }
    await Promise.race([
      this.idle(),
      new Promise((resolve) => setTimeout(resolve, options.timeoutMs ?? 120_000)),
    ]);
    await this.ticking;
    await this.recordLive();
  }
}
