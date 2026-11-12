// The web terminal's tmux bridge (spec 35, ADR 0440): the control-mode parser, and the bridge on the
// real tmux (skipped when tmux isn't installed) on its own socket.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { TerminalBridge, TerminalSize } from "@software-factory/runner-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ControlParser,
  decodeOutput,
  hexKeys,
  openTmuxTerminal,
  snapshotBytes,
  tmuxCli,
} from "../src/index.ts";
import { skipTmuxControlTests } from "../src/testing.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("tmux control mode, parsed", () => {
  it("decodes %output's octal escapes into the pane's bytes", () => {
    expect(dec(decodeOutput(enc("\\033[31mred\\033[0m \\134 back\\015\\012")))).toBe(
      "\x1b[31mred\x1b[0m \\ back\r\n",
    );
    // A backslash not followed by three octal digits stays as it is.
    expect(dec(decodeOutput(enc("a\\9b\\0")))).toBe("a\\9b\\0");
    // UTF-8 passes through.
    expect(dec(decodeOutput(enc("❯ ok")))).toBe("❯ ok");
  });

  it("splits output, this client's command blocks and exit, across chunk boundaries", () => {
    const outputs: [string, string][] = [];
    const blocks: { ok: boolean; lines: string[] }[] = [];
    const exits: string[] = [];
    const parser = new ControlParser({
      output: (pane, bytes) => outputs.push([pane, dec(bytes)]),
      block: (b) => blocks.push({ ok: b.ok, lines: b.lines.map(dec) }),
      exit: (reason) => exits.push(reason),
    });
    const stream = [
      // The attach's own block (flag 0) is not one of ours.
      "%begin 1 10 0\n%end 1 10 0\n",
      "%session-changed $0 sf-job\n",
      "%begin 1 11 1\n%0 100 30\n%end 1 11 1\n",
      "%output %0 hel",
      "lo\\015\\012\n%output %1 other pane\n",
      // A screen line that looks like an end marker but with another number is content.
      "%begin 1 12 1\nline one\n%end 1 99 1\n%end 1 12 1\n",
      "%begin 1 13 1\nbad target\n%error 1 13 1\n",
      "%exit\n",
    ];
    for (const chunk of stream) parser.push(enc(chunk));
    expect(outputs).toEqual([
      ["%0", "hello\r\n"],
      ["%1", "other pane"],
    ]);
    expect(blocks).toEqual([
      { ok: true, lines: ["%0 100 30"] },
      { ok: true, lines: ["line one", "%end 1 99 1"] },
      { ok: false, lines: ["bad target"] },
    ]);
    expect(exits).toEqual(["detached"]);
  });

  it("reads pause-after's %extended-output and %pause (spec 43: no control_discard path)", () => {
    const outputs: [string, string][] = [];
    const paused: string[] = [];
    const parser = new ControlParser({
      output: (pane, bytes) => outputs.push([pane, dec(bytes)]),
      block: () => {},
      exit: () => {},
      pause: (pane) => paused.push(pane),
    });
    parser.push(enc("%extended-output %0 1234 : a : b\\015\\012\n%extended-output %1 5 : \n"));
    parser.push(enc("%pause %0\n"));
    expect(outputs).toEqual([
      ["%0", "a : b\r\n"],
      ["%1", ""],
    ]);
    expect(paused).toEqual(["%0"]);
  });

  it("types as hex, so nothing typed is a tmux command, and redraws with the cursor", () => {
    expect(hexKeys("a; kill-server\r")).toEqual([
      ["61", "3b", "20", "6b", "69", "6c", "6c", "2d", "73", "65", "72", "76", "65", "72", "0d"],
    ]);
    expect(hexKeys("x".repeat(600)).map((c) => c.length)).toEqual([256, 256, 88]);
    expect(hexKeys("é")).toEqual([["c3", "a9"]]);
    const shot = dec(
      snapshotBytes(["one", "two", "three"], { x: 2, y: 1, visible: true }, { cols: 80, rows: 2 }),
    );
    expect(shot).toBe("\x1b[?25l\x1b[0m\x1b[H\x1b[2Jone\x1b[0m\r\ntwo\x1b[0m\x1b[2;3H\x1b[?25h");
  });
});

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
// A server of this file's own (never another test file's, run beside it), kept up for the whole
// file: tmux's server exits when its last session goes, and a test that starts a session while the
// one before's server is still exiting got "server exited unexpectedly" (CI, five PRs).
const SOCKET = `sf-term-test-${process.pid}-${randomBytes(4).toString("hex")}`;
const tmux = tmuxCli({ socket: SOCKET });

beforeAll(async () => {
  if (!hasTmux || skipTmuxControlTests()) return;
  const started = await tmux.call(["start-server", ";", "set-option", "-g", "exit-empty", "off"]);
  if (started.code !== 0) throw new Error(`tmux start-server: ${started.stderr}`);
  // It answers before any test uses it.
  await until("the test's tmux server answers", async () => {
    const r = await tmux.call(["display-message", "-p", "#{pid}"]);
    return r.code === 0 && /^\d+$/.test(r.stdout.trim());
  });
});

afterAll(() => {
  // Only this file's own server.
  spawnSync("tmux", ["-L", SOCKET, "kill-server"]);
});

/** Waits until the pane has stopped changing: its cursor and the bytes the bridge has seen. */
async function settled(name: string, seen: () => number) {
  let last = "";
  let stable = 0;
  await until("the pane to settle", async () => {
    const r = await tmux.call([
      "display-message",
      "-p",
      "-t",
      `=${name}:`,
      "#{cursor_x} #{cursor_y}",
    ]);
    const now = `${r.stdout.trim()} ${seen()}`;
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable < 3) await sleep(50);
    return stable >= 3;
  });
}

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!hasTmux || skipTmuxControlTests())(
  "the bridge on the real tmux",
  { timeout: 30_000 },
  () => {
    it("streams output, types control characters, resizes, redraws and reports exit", async () => {
      const name = "sf-job_term";
      // `cat -v` shows control characters as text, so typing them is visible.
      await tmux.newSession({ name, cwd: "/", command: "cat -v", width: 100, height: 30 });
      let out = "";
      let all = "";
      const chunks: string[] = [];
      const sizes: TerminalSize[] = [];
      const exits: string[] = [];
      const bridge: TerminalBridge = await openTmuxTerminal({
        session: name,
        socket: SOCKET,
        size: null,
        onOutput: (bytes) => {
          const text = dec(bytes);
          out += text;
          all += text;
          chunks.push(text);
        },
        onSize: (s) => sizes.push(s),
        onExit: (r) => exits.push(r),
      });
      // Opened without a size: the pane keeps its own, and the first redraw came.
      expect(sizes[0]).toEqual({ cols: 100, rows: 30 });
      expect(out).toContain("\x1b[2J");

      await bridge.write("hello\r");
      await until("typed text echoed", () => out.includes("hello"));
      // An arrow key (ESC [ A) and Ctrl-B, typed as raw bytes.
      await bridge.write("\x1b[A\x02\r");
      await until("control characters", () => out.includes("^[[A^B"));

      await bridge.resize({ cols: 90, rows: 20 });
      expect(sizes.at(-1)).toEqual({ cols: 90, rows: 20 });
      const real = await tmux.call([
        "display-message",
        "-p",
        "-t",
        `=${name}:`,
        "#{pane_width}x#{pane_height}",
      ]);
      expect(real.stdout.trim()).toBe("90x20");

      // Nothing still on its way from the pane (the echo of the Enter, the resize's own redraw), so
      // the redraw below is the screen as it is and the cursor read after it is the one it drew.
      await settled(name, () => all.length);
      out = "";
      const before = chunks.length;
      await bridge.redraw();
      // The redraw is one write of its own: clear, the screen, the cursor.
      const redrawn = chunks
        .slice(before)
        .find((c) => c.startsWith("\x1b[?25l\x1b[0m\x1b[H\x1b[2J"));
      expect(redrawn, JSON.stringify(chunks.slice(before))).toBeDefined();
      // The cursor goes where tmux has it, not the top left (spec 42 found it at 1;1).
      const cursor = await tmux.call([
        "display-message",
        "-p",
        "-t",
        `=${name}:`,
        "#{cursor_x} #{cursor_y}",
      ]);
      const [cx, cy] = cursor.stdout.trim().split(" ").map(Number);
      expect(redrawn).toContain(`\x1b[${(cy ?? 0) + 1};${(cx ?? 0) + 1}H`);
      expect(cy).toBeGreaterThan(0);
      // The next command still gets its own answer.
      await bridge.resize({ cols: 91, rows: 21 });
      expect(sizes.at(-1)).toEqual({ cols: 91, rows: 21 });
      expect(out).toContain("hello");
      expect(out).toContain("^[[A^B");

      await tmux.kill(name);
      await until("exit", () => exits.length > 0);
      await bridge.close();
    });

    it("keeps every command's answer its own when a command line fails (a pane that has gone)", async () => {
      const name = "sf-job_gone";
      await tmux.newSession({ name, cwd: "/", command: "cat", width: 80, height: 24 });
      let out = "";
      const bridge = await openTmuxTerminal({
        session: name,
        socket: SOCKET,
        size: null,
        onOutput: (bytes) => {
          out += dec(bytes);
        },
        onSize: () => {},
        onExit: () => {},
      });
      // A second pane keeps the session (and the control client) alive; the bridged one goes.
      const first = (
        await tmux.call(["display-message", "-p", "-t", `=${name}:`, "#{pane_id}"])
      ).stdout.trim();
      await tmux.call(["split-window", "-d", "-t", `=${name}:`, "cat"]);
      await tmux.call(["kill-pane", "-t", first]);

      // The redraw's line of two commands fails at the first: tmux sends one %error and drops the
      // second. Nothing is drawn, and the commands after it still get their own answers (before, the
      // redraw's second reader took the next command's answer and every reply after was off by one).
      out = "";
      await bridge.redraw();
      expect(out).toBe("");
      const done = await Promise.race([
        bridge.resize({ cols: 75, rows: 20 }).then(() => "answered"),
        sleep(5_000).then(() => "hung"),
      ]);
      expect(done).toBe("answered");
      await bridge.redraw();
      expect(out).toBe("");
      await bridge.close();
      await tmux.kill(name);
    });

    it("refuses a session that isn't there, and closes cleanly twice", async () => {
      await expect(
        openTmuxTerminal({
          session: "sf-job_missing",
          socket: SOCKET,
          size: null,
          onOutput: () => {},
          onSize: () => {},
          onExit: () => {},
        }),
      ).rejects.toThrow(/can't bridge/);

      const name = "sf-job_closing";
      await tmux.newSession({ name, cwd: "/", command: "cat", width: 80, height: 24 });
      const exits: string[] = [];
      const bridge = await openTmuxTerminal({
        session: name,
        socket: SOCKET,
        size: { cols: 70, rows: 22 },
        onOutput: () => {},
        onSize: () => {},
        onExit: (r) => exits.push(r),
      });
      const real = await tmux.call([
        "display-message",
        "-p",
        "-t",
        `=${name}:`,
        "#{pane_width}x#{pane_height}",
      ]);
      expect(real.stdout.trim()).toBe("70x22");
      await bridge.close();
      await bridge.close();
      await until("the client went", () => exits.length > 0);
      // The session is still there: only the bridge went.
      expect(await tmux.paneState(name)).not.toBeNull();
      await tmux.kill(name);
    });
  },
);
