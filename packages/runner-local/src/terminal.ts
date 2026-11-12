// The web terminal's bridge to a job's tmux pane (spec 35, ADR 0440): a tmux control-mode client
// (`tmux -L software-factory -C attach -t =sf-<jobId>`) over plain pipes. No PTY and no native
// module: tmux sends the pane's output as `%output` lines (octal escapes for control bytes and `\`),
// and takes commands on stdin, each answered by a `%begin … %end` (or `%error`) block in order with
// the output. Input is typed with `send-keys -H` (hex, so nothing a person types can become a tmux
// command), the size is `refresh-client -C <cols>x<rows>` (only when asked: a control client that
// never sets a size doesn't change the pane), and a redraw is `capture-pane -p -e` plus the cursor.
import { type ChildProcess, spawn } from "node:child_process";
import {
  clampSize,
  type OpenTerminalOptions,
  type TerminalBridge,
  type TerminalSize,
} from "@software-factory/runner-contract";
import { TMUX_SOCKET } from "./tmux.ts";

/** Decodes a `%output` value: `\ooo` (three octal digits) is one byte; everything else is as sent. */
export function decodeOutput(escaped: Uint8Array): Uint8Array {
  const out = new Uint8Array(escaped.length);
  let n = 0;
  for (let i = 0; i < escaped.length; i++) {
    const b = escaped[i] as number;
    if (
      b === 0x5c &&
      isOctal(escaped[i + 1]) &&
      isOctal(escaped[i + 2]) &&
      isOctal(escaped[i + 3])
    ) {
      out[n++] =
        (((escaped[i + 1] as number) - 0x30) << 6) |
        (((escaped[i + 2] as number) - 0x30) << 3) |
        ((escaped[i + 3] as number) - 0x30);
      i += 3;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

const isOctal = (b: number | undefined) => b !== undefined && b >= 0x30 && b <= 0x37;

/** `send-keys -H` arguments for some text, in commands of at most `per` bytes. */
export function hexKeys(data: string, per = 256): string[][] {
  const bytes = new TextEncoder().encode(data);
  const chunks: string[][] = [];
  for (let i = 0; i < bytes.length; i += per) {
    chunks.push([...bytes.subarray(i, i + per)].map((b) => b.toString(16).padStart(2, "0")));
  }
  return chunks;
}

/** A redraw: clear, the captured lines, then the cursor where tmux has it. */
export function snapshotBytes(
  captured: string[],
  cursor: { x: number; y: number; visible: boolean },
  size: TerminalSize,
): Uint8Array {
  const lines = captured.slice(0, size.rows);
  const text =
    "\x1b[?25l\x1b[0m\x1b[H\x1b[2J" +
    lines.join("\x1b[0m\r\n") +
    `\x1b[0m\x1b[${cursor.y + 1};${cursor.x + 1}H` +
    (cursor.visible ? "\x1b[?25h" : "");
  return new TextEncoder().encode(text);
}

type Block = { ok: boolean; lines: Uint8Array[] };

/**
 * Reads tmux control mode's stdout: `%output` for the pane, command blocks (the ones this client
 * sent, flag 1, matched first in first out), `%exit`. Lines inside a block are taken as they are,
 * until the `%end`/`%error` with the block's own number.
 */
export class ControlParser {
  private buffer = new Uint8Array(0);
  private block: { number: string; mine: boolean; lines: Uint8Array[] } | null = null;

  constructor(
    private readonly on: {
      output: (pane: string, bytes: Uint8Array) => void;
      block: (block: Block) => void;
      exit: (reason: string) => void;
    },
  ) {}

  push(chunk: Uint8Array) {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    let start = 0;
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] !== 0x0a) continue;
      this.line(joined.subarray(start, i));
      start = i + 1;
    }
    this.buffer = joined.slice(start);
  }

  private line(raw: Uint8Array) {
    const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
    const head = new TextDecoder().decode(line.subarray(0, Math.min(line.length, 64)));
    if (this.block) {
      const end = /^%(end|error) \d+ (\d+) \d+$/.exec(new TextDecoder().decode(line));
      if (end && end[2] === this.block.number) {
        const done = this.block;
        this.block = null;
        if (done.mine) this.on.block({ ok: end[1] === "end", lines: done.lines });
        return;
      }
      this.block.lines.push(line.slice());
      return;
    }
    const begin = /^%begin \d+ (\d+) (\d+)/.exec(head);
    if (begin) {
      this.block = { number: begin[1] as string, mine: (Number(begin[2]) & 1) === 1, lines: [] };
      return;
    }
    if (head.startsWith("%output ")) {
      const space = line.indexOf(0x20, 8);
      if (space < 0) return;
      const pane = new TextDecoder().decode(line.subarray(8, space));
      this.on.output(pane, decodeOutput(line.subarray(space + 1)));
      return;
    }
    if (head.startsWith("%exit")) this.on.exit(head.slice(5).trim() || "detached");
  }
}

export interface TmuxTerminalOptions extends OpenTerminalOptions {
  /** The job's tmux session (`sf-<jobId>`). */
  session: string;
  bin?: string;
  socket?: string;
  /** How a control client is started (tests may wrap it). */
  spawnTmux?: (bin: string, args: string[]) => ChildProcess;
}

const defaultSpawn = (bin: string, args: string[]) => {
  // Not nested in the host's own tmux, if it runs in one.
  const { TMUX: _, TMUX_PANE: __, ...env } = process.env;
  return spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
};

/**
 * Bridges a job's tmux pane: starts a control client, reports the pane's size, resizes it when
 * `options.size` is given, and redraws. Rejects when the session isn't there.
 */
export async function openTmuxTerminal(options: TmuxTerminalOptions): Promise<TerminalBridge> {
  const bin = options.bin ?? "tmux";
  const socket = options.socket ?? TMUX_SOCKET;
  const child = (options.spawnTmux ?? defaultSpawn)(bin, [
    "-L",
    socket,
    "-f",
    "/dev/null",
    "-C",
    "attach-session",
    "-t",
    `=${options.session}`,
  ]);
  /**
   * Command lines waiting for their blocks, in order. A line of `count` commands gets one block per
   * command, unless one fails: then tmux answers that one with `%error` and drops the rest of the
   * line, so the `%error` ends the whole line (the commands after it read as failed).
   */
  const pending: { count: number; blocks: Block[]; resolve: (b: Block[]) => void }[] = [];
  const failed = (n: number): Block[] => Array.from({ length: n }, () => ({ ok: false, lines: [] }));
  let pane: string | null = null;
  let exited = false;
  let stderr = "";
  const exit = (reason: string) => {
    if (exited) return;
    exited = true;
    for (const p of pending.splice(0)) p.resolve([...p.blocks, ...failed(p.count - p.blocks.length)]);
    options.onExit(reason);
  };
  const parser = new ControlParser({
    output: (id, bytes) => {
      if (id === pane && bytes.length > 0) options.onOutput(bytes);
    },
    block: (block) => {
      const line = pending[0];
      if (!line) return;
      line.blocks.push(block);
      if (block.ok && line.blocks.length < line.count) return;
      pending.shift();
      line.resolve([...line.blocks, ...failed(line.count - line.blocks.length)]);
    },
    exit,
  });
  child.stdout?.on("data", (chunk: Buffer) => parser.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2_000);
  });
  child.on("error", (error) => exit(error.message));
  child.on("close", (code) => exit(stderr.trim() || `tmux exited ${code ?? "on a signal"}`));
  child.stdin?.on("error", () => {});

  /** One command line; resolves with its block. */
  const command = async (line: string): Promise<Block> =>
    (await commands(line, 1))[0] ?? { ok: false, lines: [] };
  /**
   * A command line of several `;`-separated commands: tmux answers each with its own block, all
   * before any more output, so they are read together and in order with the output stream. One
   * that fails ends the line (see `pending`).
   */
  function commands(line: string, count: number): Promise<Block[]> {
    if (exited || !child.stdin?.writable) return Promise.resolve(failed(count));
    return new Promise((resolve) => {
      pending.push({ count, blocks: [], resolve });
      child.stdin?.write(`${line}\n`);
    });
  }
  const text = (block: Block) => block.lines.map((l) => new TextDecoder().decode(l));

  let size: TerminalSize = { cols: 80, rows: 24 };
  const readSize = async (): Promise<TerminalSize | null> => {
    const r = await command(
      `display-message -p -t ${pane ?? `=${options.session}:`} "#{pane_width} #{pane_height}"`,
    );
    const [cols, rows] = (text(r)[0] ?? "").split(" ").map(Number);
    if (!r.ok || !cols || !rows) return null;
    return { cols, rows };
  };

  const first = await command(
    `display-message -p -t =${options.session}: "#{pane_id} #{pane_width} #{pane_height}"`,
  );
  const [id, cols, rows] = (text(first)[0] ?? "").split(" ");
  if (!first.ok || !id?.startsWith("%")) {
    child.kill();
    throw new Error(`can't bridge ${options.session}: ${stderr.trim() || "no such session"}`);
  }
  pane = id;
  size = { cols: Number(cols) || 80, rows: Number(rows) || 24 };

  const bridge: TerminalBridge = {
    async write(data) {
      for (const keys of hexKeys(data)) {
        await command(`send-keys -t ${pane} -H ${keys.join(" ")}`);
      }
    },
    async resize(next) {
      const s = clampSize(next);
      await command(`refresh-client -C ${s.cols}x${s.rows}`);
      const now = await readSize();
      if (now) {
        size = now;
        options.onSize(now);
      }
    },
    async redraw() {
      // One command line, so the screen and the cursor are read together, in order with the output.
      // It answers with two blocks, one per command (reading only one put the cursor at 1;1 and
      // handed the second block to the next command).
      const [screen, cursor] = await commands(
        `capture-pane -p -e -t ${pane} ; display-message -p -t ${pane} "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{cursor_flag}"`,
        2,
      );
      if (!screen?.ok || !cursor?.ok) return;
      const lines = text(screen);
      const [x, y, w, h, visible] = (text(cursor)[0] ?? "").split(" ").map(Number);
      if (w && h) size = { cols: w, rows: h };
      options.onSize(size);
      options.onOutput(
        snapshotBytes(lines, { x: x ?? 0, y: y ?? 0, visible: visible === 1 }, size),
      );
    },
    async close() {
      if (exited) return;
      child.stdin?.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      timer.unref?.();
    },
  };

  options.onSize(size);
  if (options.size) await bridge.resize(options.size);
  await bridge.redraw();
  return bridge;
}
