// The PlanningHub (spec 20, ADR 0350): one Durable Object per work item that knows when its
// planning changed (and, since ADR 0400, wakes the runner host's held steer call). The outbox delivers each `planning.changed` here; the hub pushes a line to every
// open Planning tab's Server-Sent-Events stream (the app re-reads `planning.get`) and wakes the
// planning agent's held `planning.wait`. It keeps no state worth saving: a hub that restarts starts
// a new sequence, and every reader re-reads D1, so nothing is lost but a wake-up the next change or
// timeout brings anyway.
import { DurableObject } from "cloudflare:workers";

/** A comment line every so often keeps proxies from closing an idle stream. */
const KEEPALIVE_MS = 25_000;
const encoder = new TextEncoder();

export class PlanningHub extends DurableObject<Env> {
  private seq = 0;
  private readonly waiters = new Set<() => void>();
  private readonly streams = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private keepalive: ReturnType<typeof setInterval> | null = null;

  /** The current sequence: pass it to `waitForChange` to miss nothing in between. */
  async current(): Promise<number> {
    return this.seq;
  }

  /** Something changed: wake every waiter and tell every open view. */
  async notify(): Promise<number> {
    this.seq++;
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
    await this.send(`event: changed\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
    return this.seq;
  }

  /**
   * Wake every waiter without telling the open views (ADR 0400): a run's steer, which the runner
   * host's held steer call waits for on the same hub. Waiters re-read D1 and wait again.
   */
  async wake(): Promise<number> {
    this.seq++;
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
    return this.seq;
  }

  /**
   * Resolves `true` at the first change after `since` (at once if one already happened), or `false`
   * after `ms` with none.
   */
  async waitForChange(since: number, ms: number): Promise<boolean> {
    if (this.seq > since) return true;
    if (ms <= 0) return false;
    return new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(false);
      }, ms);
      this.waiters.add(wake);
    });
  }

  /** A Server-Sent-Events stream of changes, for one open Planning tab. */
  async stream(): Promise<ReadableStream<Uint8Array>> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.streams.add(writer);
    // `retry` tells the browser how soon to reconnect; the first event lets it re-read at once.
    void writer
      .write(
        encoder.encode(
          `retry: 2000\nevent: changed\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`,
        ),
      )
      .catch(() => this.drop(writer));
    this.keepalive ??= setInterval(() => void this.send(": keepalive\n\n"), KEEPALIVE_MS);
    return readable;
  }

  /** How many views and waiters are attached (tests). */
  async listeners(): Promise<{ streams: number; waiters: number }> {
    return { streams: this.streams.size, waiters: this.waiters.size };
  }

  private async send(text: string) {
    const bytes = encoder.encode(text);
    await Promise.all(
      [...this.streams].map((writer) => writer.write(bytes).catch(() => this.drop(writer))),
    );
  }

  private drop(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.streams.delete(writer);
    void writer.close().catch(() => {});
    if (this.streams.size === 0 && this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }
}

/** The work item's hub. */
export function planningHub(env: Env, workItemId: string) {
  return env.PLANNING_HUB.get(env.PLANNING_HUB.idFromName(workItemId));
}
