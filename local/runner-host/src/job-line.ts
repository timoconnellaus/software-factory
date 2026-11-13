// The job line (spec 44 part B, ADR 0592): one hibernatable WebSocket per running job to the job's
// relay, which pushes `{ t: "steer" | "viewer" | "planning" }` when there is something to fetch.
// The steer, terminal and planning loops wait on it instead of holding their calls, and make their
// own fenced call (`waitMs: 0`) on each push, so a push only wakes and every hand-over goes through
// the existing calls (spec 44 rule 1).
//
// Used only when this host declares `job-line` (hostManifest) and the engine's heartbeat does too.
// Otherwise, or while the line is down, `up()` is false and the loops keep their held calls. A
// line call answered 404 or `unavailable` (an engine without it, or rolled back) is asked again a
// minute later. The host pings every LINE_PING_MS; no pong within LINE_PONG_DEADLINE_MS is a
// half-open line, closed and reopened with backoff. Every (re)connect wakes every loop once, so
// nothing that happened while the line was down is missed; and every LINE_SAFETY_POLL_MS each
// loop calls once anyway, so a push lost to a half-open socket is noticed within 5 minutes.
import { setTimeout as sleep } from "node:timers/promises";
import {
  ChannelCallError,
  type ControlPlaneClient,
  type Job,
  LINE_PING,
  LINE_PING_MS,
  LINE_PONG,
  LINE_PONG_DEADLINE_MS,
  LINE_SAFETY_POLL_MS,
  type LineMessage,
  lineMessageSchema,
} from "@software-factory/runner-contract";

export type LineKind = LineMessage["t"];

/** A line up this long counts as healthy: its next drop starts the backoff again from 1 s. */
const STABLE_MS = 60_000;

/** How long to leave an engine without the line before asking again. */
const RETRY_UNAVAILABLE_MS = 60_000;

/** A WebSocket the line can use (Node's global one; tests may pass another). */
export type LineSocketFactory = (url: string) => WebSocket;

export class JobLine {
  private open = false;
  private readonly waiters = new Set<{ kind: LineKind | null; wake: () => void }>();
  /** Pushes that came while no loop was waiting (it was making its call): the next wait returns. */
  private readonly pending = new Set<LineKind>();

  constructor(
    private readonly options: {
      cp: ControlPlaneClient;
      job: Job;
      signal: AbortSignal;
      log: (message: string) => void;
      /** Whether the engine's last heartbeat declared `job-line`. */
      engineHasLine: () => boolean;
      socket?: LineSocketFactory;
      /** Shorter timings for tests. */
      timings?: Partial<{
        pingMs: number;
        pongMs: number;
        retryMs: number;
        unavailableMs: number;
        stableMs: number;
      }>;
    },
  ) {}

  /** Whether the line is up: the loops then call with `waitMs: 0` and wait on `next()`. */
  up(): boolean {
    return this.open;
  }

  /**
   * Resolves on a push of `kind`, when the line goes up or down (each loop then calls once, and
   * picks held calls or the line), when `signal` aborts, or after `ms` (the safety poll).
   */
  next(kind: LineKind, signal: AbortSignal, ms = LINE_SAFETY_POLL_MS): Promise<void> {
    if (this.pending.delete(kind) || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = {
        kind,
        wake: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", waiter.wake);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      const timer = setTimeout(waiter.wake, ms);
      signal.addEventListener("abort", waiter.wake, { once: true });
      this.waiters.add(waiter);
    });
  }

  /** Keeps the line open for the job's life. Returns when the job's signal aborts. */
  async run(): Promise<void> {
    const { cp, job, signal, log } = this.options;
    const t = {
      pingMs: LINE_PING_MS,
      pongMs: LINE_PONG_DEADLINE_MS,
      retryMs: 1_000,
      unavailableMs: RETRY_UNAVAILABLE_MS,
      stableMs: STABLE_MS,
      ...this.options.timings,
    };
    if (!cp.line) return;
    let failures = 0;
    // Exponential backoff with full jitter, up to a minute: a line that keeps dropping doesn't
    // reconnect every second (each costs a request, a read and a relay wake).
    const backoff = () =>
      sleep(Math.random() * Math.min(t.retryMs * 2 ** failures, 60_000), undefined, {
        signal,
      }).catch(() => {});
    while (!signal.aborted) {
      if (!this.options.engineHasLine()) {
        await sleep(t.unavailableMs, undefined, { signal }).catch(() => {});
        continue;
      }
      let url: string;
      try {
        url = (await cp.line(job.jobId, { fencingToken: job.lease.fencingToken })).connect.url;
        // The job ended while the call was out: never open a line for it.
        if (signal.aborted) return;
      } catch (error) {
        if (signal.aborted) return;
        // Fenced or killed: the job's own calls stop it; the line just ends.
        if (error instanceof ChannelCallError && error.status === 409) return;
        const unavailable =
          error instanceof ChannelCallError && (error.status === 404 || error.status === 503);
        log(`${job.jobId}: no job line (${error instanceof Error ? error.message : error})`);
        if (unavailable) {
          await sleep(t.unavailableMs, undefined, { signal }).catch(() => {});
        } else {
          failures++;
          await backoff();
        }
        continue;
      }
      const upFor = await this.connect(url, t);
      // Only a line that stayed up a while resets the backoff.
      if (upFor >= t.stableMs) failures = 0;
      else failures++;
      if (!signal.aborted) await backoff();
    }
  }

  /** One connection: resolves when it closes, with how long it was up (0: it never opened). */
  private connect(url: string, t: { pingMs: number; pongMs: number }): Promise<number> {
    const { job, signal, log } = this.options;
    if (signal.aborted) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      const ws = (this.options.socket ?? ((u: string) => new WebSocket(u)))(url);
      let openedAt = 0;
      let ping: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (ping) clearInterval(ping);
        if (deadline) clearTimeout(deadline);
        signal.removeEventListener("abort", stop);
        if (this.open) {
          this.open = false;
          this.wakeAll();
        }
        resolve(openedAt ? Date.now() - openedAt : 0);
      };
      const stop = () => {
        try {
          ws.close(1000, "job over");
        } catch {
          // already closed
        }
        finish();
      };
      signal.addEventListener("abort", stop, { once: true });
      // Aborted between the check above and here: an abort event won't come again.
      if (signal.aborted) {
        stop();
        return;
      }
      ws.addEventListener("open", () => {
        if (done) return;
        openedAt = Date.now();
        this.open = true;
        log(`${job.jobId}: job line open`);
        // Up: every loop calls once now (anything missed while down), then waits on pushes.
        this.wakeAll();
        ping = setInterval(() => {
          try {
            ws.send(LINE_PING);
          } catch {
            return;
          }
          // No pong in time: a half-open line. Close it; the loop reopens it.
          deadline ??= setTimeout(() => {
            log(`${job.jobId}: job line went quiet; reopening`);
            try {
              ws.close(4002, "no pong");
            } catch {
              // already closed
            }
            finish();
          }, t.pongMs);
        }, t.pingMs);
      });
      ws.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        if (data === LINE_PONG) {
          if (deadline) clearTimeout(deadline);
          deadline = null;
          return;
        }
        try {
          const msg = lineMessageSchema.safeParse(JSON.parse(data));
          if (msg.success) this.wake(msg.data.t);
        } catch {
          // Not a line message.
        }
      });
      ws.addEventListener("close", finish);
      ws.addEventListener("error", () => {
        try {
          ws.close();
        } catch {
          // already closed
        }
        finish();
      });
    });
  }

  private wake(kind: LineKind) {
    const waiting = [...this.waiters].filter((w) => w.kind === kind);
    if (waiting.length === 0) this.pending.add(kind);
    for (const w of waiting) w.wake();
  }

  private wakeAll() {
    for (const w of [...this.waiters]) w.wake();
  }
}
