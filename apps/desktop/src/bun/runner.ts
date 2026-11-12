// This Mac's runner, supervised by the app (ADR 0370): `sf-runner run` on the bundled Node 24,
// restarted with backoff, stopped on quit. sf-runner's own host lock (local/runner-host) refuses a
// second host, so an orphaned one or a launchd service can't run beside it. The app takes over a
// launchd service only when the person asks, keeping the runner's identity (its config file).
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunnerState } from "../shared/rpc.ts";
import { nextRestart } from "./backoff.ts";

const RUNNER_DIR = resolve("../Resources/app/runner");
const NODE = join(RUNNER_DIR, "node");
const SF_RUNNER = join(RUNNER_DIR, "sf-runner.mjs");
/** sf-runner exits with this when another host holds the lock. */
const LOCKED_EXIT = 3;

const home = process.env.HOME ?? homedir();
export const runnerConfigFile = () =>
  process.env.SF_RUNNER_CONFIG ??
  join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "software-factory", "runner.json");
export const launchdPlist = () =>
  join(home, "Library", "LaunchAgents", "com.software-factory.runner.plist");

/**
 * The PATH the runner needs (git, orca, claude, pnpm), from the person's login shell, as
 * `sf-runner install` captures it. Nothing else from the shell is passed on: no tokens.
 */
async function loginPath(): Promise<string> {
  try {
    const proc = Bun.spawn(["/bin/zsh", "-lc", 'printf %s "$PATH"'], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    if (out) return out;
  } catch {
    // fall through
  }
  return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

export class Runner {
  state: RunnerState = { status: "stopped", pid: null, restarts: 0, lastLine: null };
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stopping = false;
  private startedAt = 0;
  private path: Promise<string> = loginPath();
  constructor(private readonly onChange: (s: RunnerState) => void) {}

  private set(patch: Partial<RunnerState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private env(path: string) {
    return { HOME: home, PATH: path, SF_RUNNER_DESKTOP: "1" };
  }

  /** Start unless unpaired or a launchd service still owns the runner. */
  async start(): Promise<void> {
    if (this.proc) return;
    if (!existsSync(runnerConfigFile())) return this.set({ status: "unpaired", pid: null });
    if (existsSync(launchdPlist())) return this.set({ status: "launchd", pid: null });
    if (!existsSync(NODE) || !existsSync(SF_RUNNER)) {
      return this.set({ status: "failed", lastLine: "this build has no bundled runner" });
    }
    this.stopping = false;
    this.set({ status: this.state.restarts ? "restarting" : "starting" });
    this.startedAt = Date.now();
    const proc = Bun.spawn([NODE, SF_RUNNER, "run"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: this.env(await this.path),
      onExit: (_p, code) => this.exited(code),
    });
    this.proc = proc;
    this.set({ status: "running", pid: proc.pid });
    void this.pump(proc.stdout as ReadableStream<Uint8Array>);
    void this.pump(proc.stderr as ReadableStream<Uint8Array>);
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const last = dec.decode(chunk).trim().split("\n").at(-1);
      if (last) this.set({ lastLine: last.slice(0, 300) });
    }
  }

  private exited(code: number | null) {
    this.proc = null;
    if (this.stopping) return this.set({ status: "stopped", pid: null });
    if (code === LOCKED_EXIT) {
      // Another host has the lock: don't fight it, look again in 30 s.
      this.set({ status: "locked", pid: null });
      setTimeout(() => void this.start(), 30_000);
      return;
    }
    const { restarts, delayMs } = nextRestart(this.state.restarts, Date.now() - this.startedAt);
    this.set({
      status: "restarting",
      pid: null,
      restarts,
      lastLine: `exited (${code}); restarting in ${delayMs / 1000} s`,
    });
    setTimeout(() => void this.start(), delayMs);
  }

  async stop(graceMs = 95_000): Promise<void> {
    this.stopping = true;
    const p = this.proc;
    if (!p) return;
    // sf-runner cancels and releases its jobs on SIGTERM (up to 90 s).
    p.kill("SIGTERM");
    const t = setTimeout(() => p.kill("SIGKILL"), graceMs);
    await p.exited;
    clearTimeout(t);
  }

  async restart(): Promise<void> {
    await this.stop(10_000);
    this.set({ restarts: 0 });
    await this.start();
  }

  /**
   * Take the runner over from launchd: unload the service and set its plist aside (renamed, so
   * `sf-runner install` can put it back), then run it here. The config, and so the identity, stays.
   */
  async takeOverFromLaunchd(): Promise<void> {
    const plist = launchdPlist();
    if (existsSync(plist)) {
      const uid = process.getuid?.() ?? 501;
      await Bun.spawn(["/bin/launchctl", "bootout", `gui/${uid}`, plist], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      renameSync(plist, `${plist}.taken-over-by-desktop`);
    }
    await this.start();
  }

  /** `sf-runner login`: the device flow. Returns the approval link it prints, for the browser. */
  async pair(open: (url: string) => void): Promise<void> {
    const proc = Bun.spawn([NODE, SF_RUNNER, "login"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: this.env(await this.path),
    });
    let opened = false;
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      const text = dec.decode(chunk);
      const url = /https:\/\/\S+/.exec(text)?.[0];
      if (url && !opened) {
        opened = true;
        open(url);
      }
      this.set({ lastLine: text.trim().split("\n").at(-1)?.slice(0, 300) ?? null });
    }
    if ((await proc.exited) === 0) await this.start();
  }
}
