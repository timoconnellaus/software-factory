// The web terminal on the runner host (spec 35, ADR 0440). While a job's session runs, the host
// keeps the signed channel's held `terminal` call open. When someone opens the run's web terminal,
// the call answers with the job relay's socket URL (a one-use ticket in it); the host connects
// outbound, starts the adapter's bridge (`openTerminal`) and relays both ways until the relay says
// nobody is watching, the session ends or the job stops. Generic: any adapter that declares
// `terminal` (a Mac's tmux today, a sandbox's daemon later) gets it.
//
// Bytes are bounded here: output is coalesced into frames of at most TERMINAL_HOST_FRAME, and while
// the socket buffers more than TERMINAL_HIGH_WATER output is dropped; once it is back under
// TERMINAL_LOW_WATER the host asks the bridge for a redraw, so a slow link jumps instead of queueing.

import { setTimeout as sleep } from "node:timers/promises";
import {
  ChannelCallError,
  type ControlPlaneClient,
  type Job,
  type OpenTerminalOptions,
  parseTerminalMessage,
  type RelayToHost,
  type RunnerAdapter,
  relayToHostSchema,
  type SessionHandle,
  TERMINAL_HIGH_WATER,
  TERMINAL_HOST_FRAME,
  TERMINAL_LOW_WATER,
  TERMINAL_WAIT_MAX_MS,
  type TerminalBridge,
  type WorkspaceHandle,
} from "@software-factory/runner-contract";
import type { JobLine } from "./job-line.ts";

/** The bits of a WebSocket the relay client uses (Node's global WebSocket; a fake in tests). */
export interface SocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type Connect = (url: string) => SocketLike;

/** Node 24's WebSocket. */
export const nodeConnect: Connect = (url) => new WebSocket(url) as unknown as SocketLike;

const isStop = (error: unknown): error is ChannelCallError =>
  error instanceof ChannelCallError &&
  error.status === 409 &&
  (error.code === "fenced" || error.code === "killed");

/**
 * The job's held `terminal` call, for an adapter that declares `terminal` and has `openTerminal`.
 * A 404 (an engine from before ADR 0440) or a 409 that isn't a stop ends it; `fenced`/`killed`
 * stops the job; anything else backs off.
 */
export async function terminalLoop(options: {
  adapter: RunnerAdapter<WorkspaceHandle, SessionHandle>;
  cp: ControlPlaneClient;
  job: Job;
  open: (options: OpenTerminalOptions) => Promise<TerminalBridge>;
  signal: AbortSignal;
  onStop: (error: ChannelCallError) => void;
  log: (message: string) => void;
  connect?: Connect;
  retryMs?: number;
  flushMs?: number;
  /** The job line: when it is up, wait on its pushes and call without holding (spec 44 part B). */
  line?: JobLine;
}): Promise<void> {
  const { adapter, cp, job, signal, log } = options;
  if (!adapter.openTerminal || !cp.terminal) return;
  if (!(await adapter.manifest()).capabilities.includes("terminal")) return;
  const wait = cp.terminal.bind(cp);
  let failures = 0;
  while (!signal.aborted) {
    let url: string | null;
    const viaLine = options.line?.up() ?? false;
    try {
      const answer = await wait(
        job.jobId,
        { fencingToken: job.lease.fencingToken, waitMs: viaLine ? 0 : TERMINAL_WAIT_MAX_MS },
        signal,
      );
      url = answer.connect?.url ?? null;
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (isStop(error)) {
        options.onStop(error);
        return;
      }
      if (error instanceof ChannelCallError && (error.status === 404 || error.status === 409)) {
        log(
          `${job.jobId}: no web terminal (${error.status} ${error.code ?? ""}); not asking again`,
        );
        return;
      }
      failures++;
      const ms = Math.min((options.retryMs ?? 5_000) * 2 ** (failures - 1), 60_000);
      await sleep(ms, undefined, { signal }).catch(() => {});
      continue;
    }
    if (!url) {
      // On the line: wait for a push (or the line going up or down, or the safety poll).
      if (viaLine && options.line?.up()) await options.line.next("viewer", signal);
      continue;
    }
    log(`${job.jobId}: someone opened the web terminal; relaying`);
    await relayTerminal({
      url,
      open: options.open,
      signal,
      log: (m) => log(`${job.jobId}: ${m}`),
      ...(options.connect ? { connect: options.connect } : {}),
      ...(options.flushMs !== undefined ? { flushMs: options.flushMs } : {}),
    });
    log(`${job.jobId}: web terminal closed`);
  }
}

/** One relay connection: resolves when it ends (nobody watching, session over, job stopped). */
export function relayTerminal(options: {
  url: string;
  open: (options: OpenTerminalOptions) => Promise<TerminalBridge>;
  signal: AbortSignal;
  log: (message: string) => void;
  connect?: Connect;
  flushMs?: number;
}): Promise<void> {
  const flushMs = options.flushMs ?? 20;
  return new Promise((resolve) => {
    let ws: SocketLike;
    try {
      ws = (options.connect ?? nodeConnect)(options.url);
    } catch (error) {
      options.log(`couldn't connect the web terminal: ${String(error)}`);
      resolve();
      return;
    }
    ws.binaryType = "arraybuffer";
    let bridge: TerminalBridge | null = null;
    let done = false;
    let queued: Uint8Array[] = [];
    let queuedBytes = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setInterval> | null = null;

    const json = (message: object) => {
      if (done) return;
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // closing
      }
    };
    const flush = () => {
      flushTimer = null;
      if (done || queuedBytes === 0) return;
      const all = new Uint8Array(queuedBytes);
      let at = 0;
      for (const chunk of queued) {
        all.set(chunk, at);
        at += chunk.length;
      }
      queued = [];
      queuedBytes = 0;
      for (let i = 0; i < all.length; i += TERMINAL_HOST_FRAME) {
        try {
          ws.send(all.subarray(i, i + TERMINAL_HOST_FRAME));
        } catch {
          return;
        }
      }
    };
    const startDrainWatch = () => {
      drainTimer ??= setInterval(() => {
        if (done || ws.bufferedAmount > TERMINAL_LOW_WATER) return;
        if (drainTimer) clearInterval(drainTimer);
        drainTimer = null;
        // Back under the low water mark: what was dropped is redrawn.
        void bridge?.redraw().catch(() => {});
      }, 50);
    };
    const output = (bytes: Uint8Array) => {
      if (done) return;
      if (drainTimer || ws.bufferedAmount > TERMINAL_HIGH_WATER) {
        queued = [];
        queuedBytes = 0;
        startDrainWatch();
        return;
      }
      queued.push(bytes);
      queuedBytes += bytes.length;
      if (queuedBytes >= TERMINAL_HOST_FRAME) flush();
      else flushTimer ??= setTimeout(flush, flushMs);
    };
    const finish = (reason?: string) => {
      if (done) return;
      if (reason) json({ t: "ended", reason });
      flush();
      done = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (drainTimer) clearInterval(drainTimer);
      options.signal.removeEventListener("abort", onAbort);
      void bridge?.close().catch(() => {});
      try {
        ws.close(1000, reason ?? "done");
      } catch {
        // already closed
      }
      resolve();
    };
    const onAbort = () => finish("the session ended");
    if (options.signal.aborted) {
      finish();
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });

    const handle = async (message: RelayToHost) => {
      switch (message.t) {
        case "open": {
          if (bridge) return;
          try {
            bridge = await options.open({
              size: message.size,
              onOutput: output,
              onSize: (size) => json({ t: "size", size }),
              onExit: (reason) => finish(reason || "the session ended"),
            });
            if (done) void bridge.close().catch(() => {});
          } catch (error) {
            options.log(`couldn't open the terminal: ${String(error)}`);
            finish(error instanceof Error ? error.message : String(error));
          }
          return;
        }
        case "input":
          await bridge?.write(message.data);
          return;
        case "resize":
          await bridge?.resize(message.size);
          return;
        case "redraw":
          await bridge?.redraw();
          return;
        case "close":
          finish();
          return;
      }
    };
    // Commands run one at a time, in the order the relay sent them.
    let chain: Promise<void> = Promise.resolve();
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = parseTerminalMessage(relayToHostSchema, event.data);
      if (!message) return;
      chain = chain
        .then(() => handle(message))
        .catch((error) => {
          options.log(`web terminal: ${String(error)}`);
        });
    });
    ws.addEventListener("close", () => finish());
    ws.addEventListener("error", () => finish());
  });
}
