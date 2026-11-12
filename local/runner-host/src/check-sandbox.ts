// The OS sandbox a local check runs in (ADR 0501, amended 2026-11-12). A check runs code the build
// agent just wrote (a postinstall script, a vitest setup file, a test), so on a runner without a
// container it gets the same floor as the harness's own Bash commands (ADR 0270), never the owner's
// shell: Anthropic's sandbox runtime (`srt`, the engine under Claude Code's sandbox), with
//   - the harness's deny lists for the home dir's credential stores (`denyHome`) and the runner's
//     own dirs (its key, other runs, the clones), read and write;
//   - writes only to the check's clean tree, its own temporary HOME and temp (not /tmp, not the rest
//     of the job's checks root, not other jobs');
//   - the network limited to the job's allowlist (`allowedDomains(profile)`), local ports allowed;
//   - the harness's credential-free environment (`harnessEnv`), with HOME and TMPDIR the check's own.
// The lists come from `@software-factory/harness-claude`; nothing here restates them.
//
// The settings never touch disk and the exit status is the command's own (./check-sandbox-child.mjs),
// and after every check everything it started is killed: its process group, then anything still
// running with its working directory under the check's root (a daemon that called setsid). On Linux
// srt's bubblewrap runs with --die-with-parent and its own pid namespace, so nothing outlives it there.
//
// Where the sandbox can't run (no `sandbox-exec` on macOS, no bubblewrap and socat on Linux, another
// platform) there is no local exec at all: the host reports each check "not run" (fail closed).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  allowedDomains,
  denyHome,
  EMPTY_DIRS,
  EMPTY_FILES,
  harnessEnv,
  TMP_DIRS,
} from "@software-factory/harness-claude";
import type { ExecResult, Job } from "@software-factory/runner-contract";
import type { Exec } from "./checks.ts";

/** The sandbox runtime's config: handed to the sandbox child on stdin, never written to disk. */
export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: true;
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
}

export interface CheckSandboxOptions {
  /** The runner's own paths no check may read: its key and config, other runs, the clones. */
  protectPaths: string[];
  platform?: NodeJS.Platform;
  home?: string;
  /** The host's environment, for PATH and the locale (nothing else is passed through). */
  env?: NodeJS.ProcessEnv;
  /** The Node that runs the sandbox child (default: this one). */
  node?: string;
  /** Whether the OS sandbox can run here (default: probed per platform). */
  available?: boolean;
}

/**
 * One check's directories, all under `root` (made by the host, removed after the job). `root` sits in
 * the runner's checks dir, which every agent's sandbox denies (protectPaths); its siblings (other
 * jobs' roots, the host's own index for the export) are unreadable to the check.
 */
export interface CheckDirs {
  /** The job's checks root: no other job's check may read it. */
  root: string;
  /** The clean tree of the commit under check: the command's working directory. */
  dir: string;
}

/** Whether the OS sandbox can run on this machine: what `srt` itself needs per platform. */
export function sandboxAvailable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === "darwin") return existsSync("/usr/bin/sandbox-exec");
  if (platform === "linux") {
    const onPath = (bin: string) =>
      (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
    return onPath("bwrap") && onPath("socat");
  }
  return false;
}

/** The sandbox for one check: the harness floor (ADR 0270) around the check's own directories. */
export function checkSandboxSettings(
  job: Pick<Job, "harness">,
  dirs: CheckDirs,
  options: Pick<CheckSandboxOptions, "protectPaths" | "platform" | "home">,
): SrtSettings {
  const home = options.home ?? homedir();
  const homeDeny = denyHome(options.platform).map((p) => join(home, p));
  return {
    network: {
      allowedDomains: allowedDomains(job.harness.profile),
      deniedDomains: [],
      strictAllowlist: true,
      // The workerd test pool and dev servers bind localhost, as in the harness.
      allowLocalBinding: true,
    },
    filesystem: {
      // Read: the home's credential stores, the runner's own dirs, other jobs' checks. The job's
      // own checks root is re-allowed (allowRead wins over denyRead).
      denyRead: [...homeDeny, ...options.protectPaths, join(dirs.root, "..")],
      allowRead: [dirs.root],
      // Write: only the check's own tree, home and temp (TMPDIR points there). Not the system temp
      // dirs the harness allows, and not the rest of the root (its empty tool dirs and git config,
      // a later round's tree), which stays the host's.
      allowWrite: [dirs.dir, join(dirs.root, "home"), join(dirs.root, "tmp")],
      denyWrite: [
        ...homeDeny,
        ...options.protectPaths,
        join(dirs.root, "empty"),
        join(dirs.root, "gitconfig"),
      ],
    },
  };
}

/** The environment a sandboxed check runs with: the harness's, with its own HOME and temp. */
export async function checkSandboxEnv(
  root: string,
  from: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  for (const d of [home, tmp, ...TMP_DIRS.map((n) => join(tmp, n))]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
  }
  for (const d of EMPTY_DIRS) await mkdir(join(root, "empty", d), { recursive: true });
  for (const f of EMPTY_FILES) await writeFile(join(root, "empty", f), "");
  await writeFile(join(root, "gitconfig"), "");
  const keep: Record<string, string> = {};
  for (const k of ["PATH", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL"]) {
    const v = from[k];
    if (v !== undefined) keep[k] = v;
  }
  return {
    ...keep,
    ...harnessEnv(root, tmp),
    HOME: home,
    TMPDIR: tmp,
    CI: "1",
    FORCE_COLOR: "0",
  };
}

/** How much output a check keeps while it runs (the report keeps only the tail). */
const OUTPUT_KEEP = 64_000;

/** How long a check's pipes may stay open after it exited and its leftovers were killed. */
const EXIT_GRACE_MS = 2_000;

/** What the sandbox child reports on fd 3: the command's own exit, never srt's. */
type ChildReport = { code: number | null } | { signal: string } | { error: string };

export interface SpawnCheckOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Written to the process's stdin, then closed (default: no stdin). */
  input?: string;
  /**
   * The process reports the command's own exit on fd 3 (./check-sandbox-child.mjs): its exit code
   * then counts only through that report, and no report, a signal or an error is a failure.
   */
  report?: boolean;
  /**
   * The check's own directory: after the check, anything still running with its working directory
   * under it is killed (a check that left a daemon, or one that called setsid to leave the group).
   */
  reapUnder?: string;
}

/**
 * Spawns `argv` in its own process group and waits for it. After EVERY check, however it ended, the
 * whole group is killed, then anything still running under `reapUnder`; a timeout or cancel does the
 * same at once and settles on `exit`, destroying the pipes, so a detached daemon that still holds
 * stdout can't keep the check open (`close` waits for every holder of the pipe).
 */
export function spawnCheck(
  argv: string[],
  options: SpawnCheckOptions,
  signal: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let killed = false;
    let settled = false;
    let reportText = "";
    const [bin = "/bin/sh", ...args] = argv;
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe", "pipe"],
      detached: true,
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
    const reportPipe = child.stdio[3] as Readable | null;
    reportPipe?.on("data", (chunk: Buffer) => {
      if (reportText.length < 4_096) reportText += chunk.toString("utf8");
    });
    reportPipe?.on("error", () => {});
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_KEEP * 2) output = output.slice(-OUTPUT_KEEP);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const kill = () => {
      killed = true;
      killGroup();
    };
    const done = async (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // Every check, not only a timed-out one: nothing it started outlives it.
      killGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      reportPipe?.destroy();
      let code = timedOut || killed ? null : exitCode;
      if (code !== null && exitSignal) code = null;
      if (exitSignal && !timedOut && !killed) output += `\nkilled by ${exitSignal}`;
      let notRun: string | undefined;
      if (options.report && code !== null) {
        const verdict = readReport(reportText, code);
        code = verdict.code;
        notRun = verdict.notRun;
        if (verdict.note) output += `\n${verdict.note}`;
        if (notRun) output += `\n${notRun}`;
      }
      if (options.reapUnder) {
        const left = await reapStrays(options.reapUnder);
        if (left.length > 0) {
          code = null;
          output += `\nleft processes running under its tree that could not be stopped: ${left.join(", ")}`;
        }
      }
      resolve({ exitCode: code, timedOut, output, ...(notRun ? { notRun } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    if (signal.aborted) kill();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      output += `\n${err.message}`;
      void done(127, null);
    });
    // `exit` once killed (the pipes may be held by a grandchild). Otherwise the check is over when
    // its own process exits: everything it left is killed at once (its group, then anything with a
    // cwd under its tree), so `close` follows as soon as the last output is read; a holder that
    // escaped both gets a short grace, then the check settles anyway.
    child.on("exit", (code, sig) => {
      if (killed) return void done(code, sig);
      killGroup();
      const reaped = options.reapUnder ? reapStrays(options.reapUnder) : Promise.resolve([]);
      void reaped.then(() => setTimeout(() => void done(code, sig), EXIT_GRACE_MS).unref());
    });
    child.on("close", (code, sig) => void done(code, sig));
  });
}

/**
 * The command's exit from the sandbox child's report. Only a report of a plain exit counts: a
 * signal, a missing or garbled report, or a child that itself exited non-zero is a failure (exit
 * code null). A sandbox that could not start is "not run".
 */
function readReport(
  text: string,
  childCode: number,
): { code: number | null; note?: string; notRun?: string } {
  let parsed: ChildReport;
  try {
    parsed = JSON.parse(text.split("\n")[0] ?? "") as ChildReport;
  } catch {
    return { code: null, note: "the sandbox reported no exit status: counted as a failure" };
  }
  if ("signal" in parsed) return { code: null, note: `killed by ${parsed.signal}` };
  // The child reports an error only before the command ran (the sandbox couldn't start).
  if ("error" in parsed) {
    return { code: null, notRun: `the sandbox could not start: ${parsed.error}`.slice(0, 300) };
  }
  if (childCode !== 0 || typeof parsed.code !== "number") {
    return { code: null, note: "the sandbox reported no exit status: counted as a failure" };
  }
  return { code: parsed.code };
}

/** The processes of this user whose working directory is `dir` or under it. */
export async function processesUnder(dir: string): Promise<number[]> {
  const prefix = dir.replace(/\/?$/, "/");
  const under = (cwd: string) => cwd === dir || cwd.startsWith(prefix);
  const out: number[] = [];
  if (process.platform === "linux") {
    for (const name of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(name)) continue;
      const cwd = await readlink(`/proc/${name}/cwd`).catch(() => null);
      if (cwd && under(cwd)) out.push(Number(name));
    }
    return out.filter((p) => p !== process.pid);
  }
  // macOS (and other BSDs): lsof lists every process's cwd for this user.
  const listed = await new Promise<string>((resolve) => {
    const p = spawn(
      "lsof",
      ["-a", "-d", "cwd", "-u", String(process.getuid?.() ?? ""), "-F", "pn"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let text = "";
    p.stdout.on("data", (c: Buffer) => {
      text += c.toString("utf8");
    });
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(text));
  });
  let pid = 0;
  for (const line of listed.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && under(line.slice(1)) && pid !== process.pid) out.push(pid);
  }
  return [...new Set(out)];
}

/** Kills everything still running under `dir`; returns what could not be stopped. */
export async function reapStrays(dir: string): Promise<number[]> {
  let left: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    left = await processesUnder(dir);
    if (left.length === 0) return [];
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone already
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return processesUnder(dir);
}

/** The sandbox child (./check-sandbox-child.mjs), run with the host's own Node. */
export const SANDBOX_CHILD = fileURLToPath(new URL("./check-sandbox-child.mjs", import.meta.url));

/**
 * Runs `command` under the sandbox `settings` in `cwd`: settings and command on stdin (no file a
 * check could reach), the command's own exit on a pipe only this host holds.
 */
export function sandboxedExec(
  settings: SrtSettings,
  command: { run: string; timeoutMs: number },
  options: { cwd: string; env: Record<string, string>; reapUnder?: string; node?: string },
  signal: AbortSignal,
): Promise<ExecResult> {
  return spawnCheck(
    [options.node ?? process.execPath, SANDBOX_CHILD],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: command.timeoutMs,
      input: JSON.stringify({ settings, command: command.run }),
      report: true,
      ...(options.reapUnder ? { reapUnder: options.reapUnder } : {}),
    },
    signal,
  );
}

/**
 * The local check exec for a job, or null when this runner has no OS sandbox (the host then reports
 * every check "not run"). Each command runs in the clean tree through ./check-sandbox-child.mjs.
 */
export function checkSandbox(
  options: CheckSandboxOptions,
): ((job: Job, dirs: CheckDirs) => Exec) | null {
  const platform = options.platform ?? process.platform;
  if (!(options.available ?? sandboxAvailable(platform, options.env))) return null;
  return (job, dirs) => async (command, signal) => {
    const settings = checkSandboxSettings(job, dirs, options);
    const env = await checkSandboxEnv(dirs.root, options.env);
    return sandboxedExec(
      settings,
      command,
      { cwd: dirs.dir, env, reapUnder: dirs.root, ...(options.node ? { node: options.node } : {}) },
      signal,
    );
  };
}
