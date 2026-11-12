// The OS sandbox a local check runs in (ADR 0501, amended 2026-11-12). A check runs code the build
// agent just wrote (a postinstall script, a vitest setup file, a test), so on a runner without a
// container it gets the same floor as the harness's own Bash commands (ADR 0270), never the owner's
// shell: Anthropic's sandbox runtime (`srt`, the engine under Claude Code's sandbox), with
//   - the harness's deny lists for the home dir's credential stores (`denyHome`) and the runner's
//     own dirs (its key, other runs, the clones), read and write;
//   - writes only to the check's clean tree, its own temporary HOME and temp (not /tmp: other jobs'
//     check trees live there);
//   - the network limited to the job's allowlist (`allowedDomains(profile)`), local ports allowed;
//   - the harness's credential-free environment (`harnessEnv`), with HOME and TMPDIR the check's own.
// The lists come from `@software-factory/harness-claude`; nothing here restates them.
//
// Where the sandbox can't run (no `sandbox-exec` on macOS, no bubblewrap and socat on Linux, another
// platform) there is no local exec at all: the host reports each check "not run" (fail closed).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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

/** The settings file `srt --settings` reads. */
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
  /** Where `srt` is (default: the dependency's CLI, run with this Node). */
  srt?: string[];
  /** Whether the OS sandbox can run here (default: probed per platform). */
  available?: boolean;
}

/** One check's directories, all under `root` (made by the host, removed after the job). */
export interface CheckDirs {
  /** The job's checks root: no other job's check may read it. */
  root: string;
  /** The clean tree of the commit under check: the command's working directory. */
  dir: string;
}

/** The sandbox runtime's CLI, run with the host's own Node. */
function srtArgv(): string[] {
  const require = createRequire(import.meta.url);
  return [process.execPath, require.resolve("@anthropic-ai/sandbox-runtime/dist/cli.js")];
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
      // dirs the harness allows: other jobs' check trees, and anything else in /tmp, stay out.
      allowWrite: [dirs.root],
      denyWrite: [...homeDeny, ...options.protectPaths],
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

/**
 * Spawns `argv` in its own process group and waits for it. A timeout or cancel kills the group and
 * settles on `exit`, destroying the pipes: a detached daemon that still holds stdout can't keep the
 * check open (`close` waits for every holder of the pipe).
 */
export function spawnCheck(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
  signal: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let killed = false;
    let settled = false;
    const [bin = "/bin/sh", ...args] = argv;
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_KEEP * 2) output = output.slice(-OUTPUT_KEEP);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const kill = () => {
      killed = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode: timedOut || killed ? null : exitCode, timedOut, output });
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
      done(127);
    });
    // `exit` once killed (the pipes may be held by a grandchild); `close` otherwise, so the last
    // output is read.
    child.on("exit", (code) => {
      if (killed) done(code);
    });
    child.on("close", (code) => done(code));
  });
}

/**
 * The local check exec for a job, or null when this runner has no OS sandbox (the host then reports
 * every check "not run"). Each command runs as `srt --settings <file> -c <run>` in the clean tree.
 */
export function checkSandbox(
  options: CheckSandboxOptions,
): ((job: Job, dirs: CheckDirs) => Exec) | null {
  const platform = options.platform ?? process.platform;
  if (!(options.available ?? sandboxAvailable(platform, options.env))) return null;
  const srt = options.srt ?? srtArgv();
  return (job, dirs) => async (command, signal) => {
    const settings = checkSandboxSettings(job, dirs, options);
    const file = join(dirs.root, "srt-settings.json");
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    const env = await checkSandboxEnv(dirs.root, options.env);
    return spawnCheck(
      [...srt, "--settings", file, "-c", command.run],
      { cwd: dirs.dir, env, timeoutMs: command.timeoutMs },
      signal,
    );
  };
}
