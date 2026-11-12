// The sprite's run files, mirrored onto the host (ADR 0480). runner-local reads a run's progress
// from files: the launch script's pid file, the status hook's `status.jsonl`, Claude's transcript
// (ADR 0380, 0400). In a sprite they are written there, so the host pulls what was appended since its
// last read into the same absolute paths on the host, and runner-local's start check, events and
// artifacts read them unchanged. The host chooses every path; a transcript path the status hook
// reports is mirrored only when it is under the job's own home dir.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SandboxApi } from "./api.ts";
import { PULL, scriptArgv } from "./scripts.ts";

export interface MirrorOptions {
  api: SandboxApi;
  sandbox: string;
  /**
   * The files to mirror now (asked before each pull): a path mirrored to the same host path, or a
   * sprite path and the host path it goes to.
   */
  files: () => Promise<Array<string | MirrorPath>> | Array<string | MirrorPath>;
  /** The most bytes taken from one file in one pull (default 4 MiB). */
  maxChunk?: number;
  /** A file is mirrored up to this size, then no further (default 64 MiB). */
  maxSize?: number;
  /** The most files mirrored (default 8): any beyond are ignored. */
  maxFiles?: number;
  /** The most bytes mirrored in all (default 256 MiB): then nothing more is taken. */
  maxTotal?: number;
  log?: (message: string) => void;
}

export interface MirrorPath {
  remote: string;
  local: string;
}

export interface Mirror {
  /** One pull of every file. */
  pull(): Promise<void>;
  /** Pulls every `intervalMs` until stopped. */
  start(intervalMs: number): void;
  /** Stops the loop after a last pull. */
  stop(): Promise<void>;
}

/** Splits a pull's output into each file's (size, bytes), in the order asked. */
export function parsePull(out: Buffer): Array<{ index: number; size: number; bytes: Buffer }> {
  const parts: Array<{ index: number; size: number; bytes: Buffer }> = [];
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(0x0a, at);
    if (nl < 0) break;
    const m = /^(\d+) (-?\d+) (\d+)$/.exec(out.subarray(at, nl).toString("utf8"));
    if (!m) throw new Error(`a pull's header is malformed: ${out.subarray(at, nl).toString()}`);
    const count = Number(m[3]);
    const bytes = out.subarray(nl + 1, nl + 1 + count);
    if (bytes.length !== count) throw new Error("a pull ended early");
    parts.push({ index: Number(m[1]), size: Number(m[2]), bytes });
    at = nl + 1 + count;
  }
  return parts;
}

export function createMirror(options: MirrorOptions): Mirror {
  const offsets = new Map<string, number>();
  const maxChunk = options.maxChunk ?? 4 << 20;
  const maxSize = options.maxSize ?? 64 << 20;
  const maxFiles = options.maxFiles ?? 8;
  const maxTotal = options.maxTotal ?? 256 << 20;
  /** Every file ever mirrored, in the order first seen: only the first `maxFiles` are. */
  const seen: string[] = [];
  let total = 0;
  let warned = false;
  let running: Promise<void> | null = null;
  let stopped = false;
  let pulling: Promise<void> = Promise.resolve();

  async function pullOnce(): Promise<void> {
    const byLocal = new Map<string, MirrorPath>();
    for (const f of await options.files()) {
      const p = typeof f === "string" ? { remote: f, local: f } : f;
      if (!byLocal.has(p.local)) byLocal.set(p.local, p);
    }
    for (const local of byLocal.keys()) {
      if (!seen.includes(local)) seen.push(local);
    }
    const allowed = new Set(seen.slice(0, maxFiles));
    if (seen.length > maxFiles && !warned) {
      warned = true;
      options.log?.(`mirror: over ${maxFiles} files; the rest aren't mirrored`);
    }
    const budget = maxTotal - total;
    if (budget <= 0) return;
    const asked = [...byLocal.values()].filter(
      (f) => allowed.has(f.local) && (offsets.get(f.local) ?? 0) < maxSize,
    );
    if (asked.length === 0) return;
    const chunk = Math.max(1, Math.min(maxChunk, Math.floor(budget / asked.length)));
    const args = [
      String(chunk),
      ...asked.flatMap((f) => [f.remote, String(offsets.get(f.local) ?? 0)]),
    ];
    const r = await options.api.exec(options.sandbox, scriptArgv(PULL, args), {
      timeoutMs: 60_000,
      maxStdout: chunk * asked.length + 64 * asked.length + 1024,
    });
    if (r.code !== 0) throw new Error(`pull exited ${r.code}: ${r.stderr.toString().trim()}`);
    for (const part of parsePull(r.stdout)) {
      const path = asked[part.index]?.local;
      if (!path || part.size < 0) continue;
      let offset = offsets.get(path) ?? 0;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (part.size < offset) {
        // Rewritten or truncated in the sprite: start the host's copy over.
        await writeFile(path, "", { mode: 0o600 });
        offset = 0;
        offsets.set(path, 0);
        continue;
      }
      if (part.bytes.length === 0) continue;
      await appendFile(path, part.bytes, { mode: 0o600 });
      offsets.set(path, offset + part.bytes.length);
      total += part.bytes.length;
    }
  }

  const pull = () => {
    // One pull at a time: the loop's and a caller's never interleave their appends.
    const next = pulling.then(pullOnce, pullOnce);
    pulling = next.catch(() => {});
    return next;
  };

  return {
    pull,
    start(intervalMs) {
      if (running) return;
      running = (async () => {
        let failures = 0;
        while (!stopped) {
          try {
            await pull();
            failures = 0;
          } catch (err) {
            failures++;
            if (failures === 1 || failures % 30 === 0) {
              options.log?.(`mirror: ${err instanceof Error ? err.message : err}`);
            }
          }
          if (stopped) break;
          await sleep(intervalMs);
        }
      })();
    },
    async stop() {
      stopped = true;
      await running;
      await pull().catch((err) =>
        options.log?.(`mirror: ${err instanceof Error ? err.message : err}`),
      );
    },
  };
}
