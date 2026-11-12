// The OS sandbox a local check runs in (ADR 0501, amended 2026-11-12 three times). A check runs code
// the build agent just wrote (a postinstall script, a vitest setup file, a test), so on a runner
// without a container it gets the harness's floor (ADR 0270) and more, never the owner's shell:
// Anthropic's sandbox runtime (`srt`, the engine under Claude Code's sandbox), with
//   - no reads of the owner's home at all: only the toolchain the check needs (node, pnpm, corepack,
//     npm, git, wherever they live under it) is re-allowed, read-only, and never a path that holds
//     a protected dir; the runner's own dirs, other jobs' and other checks' dirs are denied too;
//   - writes only to the check's own tree, HOME, temp and pnpm store (all under the check's own
//     dir, which no earlier check could write: ./checks.ts);
//   - the network limited to the job's allowlist (`allowedDomains(profile)`) through the sandbox's
//     own proxy, and no loopback but that proxy (no service on the owner's 127.0.0.1);
//   - the harness's credential-free environment (`harnessEnv`), with HOME, TMPDIR and the pnpm
//     store the check's own.
// The deny lists come from `@software-factory/harness-claude`; nothing here restates them.
//
// The sandbox runtime's own sockets go in a short private dir (`socketsDir`): the check's temp is
// too deep for a unix socket's path. The settings never touch disk and the exit status is the
// command's own (./check-sandbox-child.mjs). After every check everything it started is killed: its
// process group, every descendant the host saw while it ran (polled from spawn), then anything still
// running with its working directory under the check's dir. On Linux srt's bubblewrap runs with
// --die-with-parent and its own pid namespace, so nothing outlives it there.
//
// Where the sandbox can't run (no `sandbox-exec` on macOS, no bubblewrap and socat on Linux, a
// kernel that refuses bubblewrap's namespaces, another platform) nothing runs: each check is "not
// run" with the reason (`sandboxTrial`, which `sf-runner doctor` can call too).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
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
import { paths } from "./config.ts";

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
  /**
   * Where the sandbox runtime's sockets go, one private dir per check (default: the runner's
   * `paths().checkSocketsDir`). Short, outside every check's writes, in every agent's protectPaths.
   */
  socketsDir?: string;
  /** The runner's checks dir, where the start-up trial makes its scratch check (default: paths()). */
  checksDir?: string;
}

/**
 * One check's directories, all under `root`, the check's own dir (`<checksDir>/<jobId>-…/r<round>-<i>`,
 * made by the host for this check alone and removed after it). The runner's checks dir is denied to
 * every agent (protectPaths); the check's siblings (other checks of the job, the job's export index)
 * and other jobs' roots are unreadable to the check.
 */
export interface CheckDirs {
  /** The check's own dir: its tree, HOME, temp and pnpm store. No other check may write it. */
  root: string;
  /** The tree the command runs in (`<root>/tree`): its working directory. */
  dir: string;
  /** The private dir for the sandbox runtime's sockets (made per check, removed after it). */
  sockets?: string;
}

/**
 * The sandbox runtime's own helpers (Linux runs `vendor/seccomp/<arch>/apply-seccomp` inside the
 * sandbox): read-only for the check, wherever the runner's checkout keeps them (under the home).
 */
export const SRT_VENDOR = (() => {
  try {
    const entry = realpathSync(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")));
    return join(dirname(dirname(entry)), "vendor");
  } catch {
    return null;
  }
})();

/** The longest unix socket path the platform takes (`sun_path`, with its NUL). */
const SOCKET_PATH_MAX: Partial<Record<NodeJS.Platform, number>> = { darwin: 104, linux: 108 };

/** The longest socket name srt makes in its temp dir (`claude-socks-<16 hex>.sock`). */
const SRT_SOCKET_NAME = "claude-socks-0123456789abcdef.sock";

/** Why `dir` is too deep for srt's sockets on this platform, or null. */
export function socketPathProblem(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const max = SOCKET_PATH_MAX[platform];
  const longest = join(dir, SRT_SOCKET_NAME).length;
  return max !== undefined && longest >= max
    ? `the sandbox's socket dir is too deep for a unix socket (${longest} of ${max - 1} characters): ${dir}`
    : null;
}

/** Is `p` the same as `dir` or inside it? */
const within = (p: string, dir: string) =>
  p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** `p`'s real path, or `p` where it doesn't resolve. */
const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The tools a check may need, found on its PATH. */
const TOOLS = ["node", "npm", "npx", "pnpm", "pnpx", "corepack", "yarn", "git", "bun"];

/**
 * The toolchain under the owner's home a check may read (the home is otherwise denied): for each
 * tool on the check's PATH, its PATH entry, and the install it resolves to (a node prefix such as
 * `~/.nvm/versions/node/v24.x`, a package such as `…/node_modules/pnpm`). Never a path that is, holds
 * or sits inside a denied one (the home itself, `~/.local`, a protected dir): srt lets an allowRead
 * win over a denyRead.
 */
export function toolchainPaths(pathEnv: string, home: string, denied: readonly string[]): string[] {
  const out = new Set<string>();
  const ok = (p: string) =>
    within(p, home) &&
    p !== home &&
    !denied.some((d) => within(p, d) || within(d, p)) &&
    // Not a whole dot-dir of the home (~/.local, ~/.config, ~/.cache, ~/Library): too broad.
    p.split(sep).length > home.split(sep).length + 1;
  const add = (p: string) => {
    if (ok(p)) out.add(p);
  };
  for (const tool of TOOLS) {
    for (const d of pathEnv.split(delimiter)) {
      if (!d) continue;
      const found = join(d, tool);
      let real: string;
      try {
        if (!statSync(found).isFile()) continue;
        real = realpathSync(found);
      } catch {
        continue;
      }
      add(d);
      // A package manager's shim script (`<x>/node_modules/.bin/pnpm`, as pnpm/action-setup lays it
      // out) runs a path in that node_modules: the whole node_modules, not just the shim.
      if (basename(d) === ".bin" && basename(dirname(d)) === "node_modules") add(dirname(d));
      // A package's own bin (…/node_modules/pnpm/bin/pnpm.cjs) or a node prefix (…/bin/node).
      const nm = real.lastIndexOf(`${sep}node_modules${sep}`);
      if (nm >= 0) {
        const rest = real.slice(nm + 14).split(sep);
        const pkg = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
        add(join(real.slice(0, nm), "node_modules", ...pkg));
        // A global install under a node prefix (<prefix>/lib/node_modules/corepack): the prefix.
        const lib = real.slice(0, nm);
        if (basename(lib) === "lib") add(dirname(lib));
      } else {
        const bin = dirname(real);
        add(basename(bin) === "bin" ? dirname(bin) : bin);
      }
      break;
    }
  }
  return [...out].sort();
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

/**
 * The user's own per-user dirs on macOS, `/var/folders/<x>/<y>/T` and `.../C`, read from
 * `getconf` (the system's own answer, from the user's uid), never from TMPDIR: the runner's launchd
 * job sets only PATH and HOME, and Node's `tmpdir()` is `/tmp` when TMPDIR is unset, which would
 * leave the real ones readable. Asked once per process. Empty when `getconf` can't answer.
 */
export function macUserDirs(env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }): string[] {
  const out: string[] = [];
  for (const name of ["DARWIN_USER_TEMP_DIR", "DARWIN_USER_CACHE_DIR"]) {
    try {
      const dir = execFileSync("/usr/bin/getconf", [name], { env, encoding: "utf8" }).trim();
      if (dir) out.push(dir);
    } catch {
      // not macOS, or no answer: the fixed temp dirs are still denied
    }
  }
  return out;
}

let cachedMacUserDirs: string[] | undefined;
function userDirsOnce(): string[] {
  if (!cachedMacUserDirs) cachedMacUserDirs = macUserDirs();
  return cachedMacUserDirs;
}

/**
 * The shared temp dirs a check on macOS may not read (fourth review, S3): `/tmp` and `/private/tmp`,
 * and the user's own `/var/folders/<x>/<y>` (its `T`, `C` and `0`, all under it), where the owner's
 * other tools keep their temp files and caches. The check's own temp is under its own dir.
 */
export function macTempDenies(userDirs: string[] = userDirsOnce()): string[] {
  const out = ["/tmp", "/private/tmp"];
  for (const dir of userDirs) {
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // as given
    }
    const m = /^(?:\/private)?(\/var\/folders\/[^/]+\/[^/]+)/.exec(real);
    if (m?.[1] && !out.includes(m[1])) out.push(m[1], `/private${m[1]}`);
  }
  return out;
}

/**
 * Programs a check on macOS may not run (fourth review): `launchctl` reads and drives the owner's
 * login session (`launchctl print gui/<uid>`), which the sandbox's mach rules don't cover (it uses
 * the bootstrap port every process inherits). Denied by path in the sandbox profile.
 */
export const MAC_DENY_EXEC = ["/bin/launchctl"];

/** The sandbox for one check: the harness floor (ADR 0270) around the check's own directories. */
export function checkSandboxSettings(
  job: Pick<Job, "harness">,
  dirs: CheckDirs,
  options: Pick<CheckSandboxOptions, "protectPaths" | "platform" | "home" | "env">,
): SrtSettings {
  const home = options.home ?? homedir();
  const homeDeny = denyHome(options.platform).map((p) => join(home, p));
  const own = checkPaths(dirs.root);
  // The rest of the job's checks (other checks, the export's index) and other jobs' checks.
  const jobRoot = dirname(dirs.root);
  const checksDir = dirname(jobRoot);
  const platform = options.platform ?? process.platform;
  // macOS (the weaker sandbox a Mac runner's owner opted in to): no shared temp dirs either.
  // The runner's checks dir is under its data dir in the home, never in a temp dir; a check dir that
  // is (a test's scratch dir) keeps the temp dir that holds it readable, or it couldn't run at all.
  const temps =
    platform === "darwin"
      ? macTempDenies().filter((t) => !within(dirs.root, t) && !within(realOr(dirs.root), t))
      : [];
  const denied = [home, ...homeDeny, ...options.protectPaths, jobRoot, checksDir, ...temps];
  const tools = toolchainPaths(
    (options.env ?? process.env).PATH ?? "",
    home,
    [...homeDeny, ...options.protectPaths, jobRoot, checksDir].filter((d) => d !== home),
  );
  return {
    network: {
      allowedDomains: allowedDomains(job.harness.profile),
      deniedDomains: [],
      strictAllowlist: true,
      // No loopback but the sandbox's own proxy: a service the owner runs on 127.0.0.1 is not the
      // check's. (On macOS this also means a check can't reach a server it starts itself; on Linux
      // the check has a loopback of its own in its network namespace.)
      allowLocalBinding: false,
    },
    filesystem: {
      // Read: none of the owner's home, the runner's own dirs, other checks and jobs. The check's
      // own paths and the toolchain are re-allowed (allowRead wins over denyRead), each by name: on
      // Linux srt re-binds an allowRead path read-only after the write binds, so allowing the
      // whole root would make the tree read-only (a write path it already re-bound is skipped).
      denyRead: denied,
      allowRead: [
        dirs.dir,
        own.home,
        own.tmp,
        own.store,
        own.empty,
        own.gitconfig,
        // Linux binds srt's proxy sockets into the sandbox from here.
        ...(dirs.sockets ? [dirs.sockets] : []),
        ...(SRT_VENDOR ? [SRT_VENDOR] : []),
        ...tools,
      ],
      // Write: only the check's own tree, home, temp and store (TMPDIR and the store point there).
      // Not the system temp dirs the harness allows, and not the rest of its dir (its empty tool
      // dirs and git config), which stays the host's.
      allowWrite: [dirs.dir, own.home, own.tmp, own.store],
      denyWrite: [...homeDeny, ...options.protectPaths, own.empty, own.gitconfig],
    },
  };
}

/** The paths of a check's own dir. */
export function checkPaths(root: string) {
  return {
    tree: join(root, "tree"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    store: join(root, "store"),
    empty: join(root, "empty"),
    gitconfig: join(root, "gitconfig"),
  };
}

/** The environment a sandboxed check runs with: the harness's, with its own HOME and temp. */
export async function checkSandboxEnv(
  root: string,
  from: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const { home, tmp, store } = checkPaths(root);
  for (const d of [home, tmp, store, ...TMP_DIRS.map((n) => join(tmp, n))]) {
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
    // The check's own pnpm store, never the agent's or another job's (ADR 0501).
    npm_config_store_dir: store,
    // Node's own fetch and http (corepack fetching pnpm) through the sandbox's proxy.
    NODE_USE_ENV_PROXY: "1",
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
  /**
   * Watch the process table from spawn and kill, after the check, every descendant seen while it ran
   * (a daemon that changed its cwd and left the group). Defence in depth: no later check runs on a
   * dir an earlier one could write (./checks.ts).
   */
  track?: boolean;
}

/** One process: its parent and when it started (so a reused pid is never killed). */
interface Proc {
  ppid: number;
  started: string;
}

/** This user's processes, by pid. */
async function processTable(): Promise<Map<number, Proc>> {
  const text = await new Promise<string>((resolve) => {
    const p = spawn("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out));
  });
  const table = new Map<number, Proc>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), started: m[3] ?? "" });
  }
  return table;
}

/** How often the tracker reads the process table while a check runs. */
const TRACK_EVERY_MS = 100;

/**
 * Every descendant of `pid` seen from now on: the process table is read every TRACK_EVERY_MS, and
 * a process stays tracked once seen, so its own children are tracked after it exits or its child
 * is reparented. `stop` reads it once more and kills every tracked process still running (same pid,
 * same start time); it returns those that survived the kill.
 */
export function trackDescendants(pid: number): { stop: () => Promise<number[]> } {
  const seen = new Map<number, string>();
  let running = true;
  const scan = async () => {
    const table = await processTable();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [p, proc] of table) {
        if (seen.has(p) || p === process.pid) continue;
        if (proc.ppid === pid || seen.has(proc.ppid)) {
          seen.set(p, proc.started);
          grew = true;
        }
      }
    }
    return table;
  };
  const loop = (async () => {
    while (running) {
      await scan();
      await new Promise((r) => setTimeout(r, TRACK_EVERY_MS).unref());
    }
  })();
  const alive = (table: Map<number, Proc>) =>
    [...seen].filter(([p, started]) => table.get(p)?.started === started).map(([p]) => p);
  return {
    async stop() {
      running = false;
      await loop;
      for (let attempt = 0; attempt < 5; attempt++) {
        const left = alive(await scan());
        if (left.length === 0) return [];
        for (const p of left) {
          try {
            process.kill(p, "SIGKILL");
          } catch {
            // gone already
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return alive(await processTable());
    },
  };
}

/**
 * Spawns `argv` in its own process group and waits for it. After EVERY check, however it ended, the
 * whole group is killed, then every descendant tracked since spawn, then anything still running
 * under `reapUnder`; a timeout or cancel does the
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
    const tracker = options.track && child.pid ? trackDescendants(child.pid) : null;
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
      const tracked = (await tracker?.stop()) ?? [];
      if (tracked.length > 0) {
        code = null;
        output += `\nleft processes running that could not be stopped: ${tracked.join(", ")}`;
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
  options: {
    cwd: string;
    env: Record<string, string>;
    reapUnder?: string;
    node?: string;
    /**
     * The sandbox runtime's own temp (its proxy sockets), short and private; the command still gets
     * `env.TMPDIR`. Default: the command's.
     */
    sockets?: string;
    /** Programs the check may not run (macOS: added to the sandbox profile). */
    denyExec?: string[];
  },
  signal: AbortSignal,
): Promise<ExecResult> {
  const childEnv = options.sockets ? { ...options.env, TMPDIR: options.sockets } : options.env;
  return spawnCheck(
    [options.node ?? process.execPath, SANDBOX_CHILD],
    {
      cwd: options.cwd,
      env: childEnv,
      timeoutMs: command.timeoutMs,
      input: JSON.stringify({
        settings,
        command: command.run,
        ...(options.env.TMPDIR !== undefined ? { tmpdir: options.env.TMPDIR } : {}),
        ...(options.denyExec?.length ? { denyExec: options.denyExec } : {}),
      }),
      report: true,
      track: true,
      ...(options.reapUnder ? { reapUnder: options.reapUnder } : {}),
    },
    signal,
  );
}

/** A sandbox that can't run here: what every check reports. */
export type TrialResult = { ok: true } | { ok: false; reason: string };

/**
 * Whether the check sandbox really starts on this machine (ADR 0501, third review): a trivial
 * command under the same settings a check gets, in a scratch check dir under the runner's checks
 * dir. False with the reason where the binaries are missing, the socket dir is too deep, or the
 * kernel refuses bubblewrap's namespaces (Ubuntu's AppArmor restriction on unprivileged user
 * namespaces). The host runs it before a job's checks; `sf-runner doctor` and the `checks`
 * capability can call it too.
 */
export async function sandboxTrial(
  options: Omit<CheckSandboxOptions, "available"> = { protectPaths: [] },
  signal: AbortSignal = new AbortController().signal,
): Promise<TrialResult> {
  const platform = options.platform ?? process.platform;
  if (!sandboxAvailable(platform, options.env)) {
    return {
      ok: false,
      reason:
        platform === "linux"
          ? "bubblewrap and socat are not both on PATH"
          : platform === "darwin"
            ? "sandbox-exec is missing"
            : `no OS sandbox on ${platform}`,
    };
  }
  const checksDir = options.checksDir ?? paths().checksDir;
  await mkdir(checksDir, { recursive: true, mode: 0o700 });
  const jobRoot = await mkdtemp(join(checksDir, "trial-"));
  try {
    const root = join(jobRoot, "r0-0");
    const dir = join(root, "tree");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const exec = runInSandbox(options, TRIAL_JOB, { root, dir });
    const marker = "sf-sandbox-trial-ok";
    const r = await exec({ run: `echo ${marker}`, timeoutMs: 60_000 }, signal);
    if (r.notRun) return { ok: false, reason: r.notRun };
    if (r.exitCode === 0 && r.output.includes(marker)) return { ok: true };
    const said = r.output.replace(/\s+/g, " ").trim().slice(-240);
    return {
      ok: false,
      reason: `a trial command exited ${r.timedOut ? "on a timeout" : (r.exitCode ?? "on a signal")}${said ? `: ${said}` : ""}`,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(jobRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** The trial's job: only its network allowlist matters (the defaults). */
const TRIAL_JOB = { harness: { id: "claude-code", role: "implement", prompt: "" } } as Pick<
  Job,
  "harness"
>;

/** How long a passed trial stands before the next job's checks run it again. */
const TRIAL_FRESH_MS = 10 * 60_000;

/**
 * Runs one command under the check sandbox for `dirs`: the check's env and dirs, a private socket
 * dir made for it (removed after), and "not run" when that dir would be too deep.
 */
function runInSandbox(
  options: CheckSandboxOptions,
  job: Pick<Job, "harness">,
  dirs: CheckDirs,
): Exec {
  return async (command, signal) => {
    const socketsDir = options.socketsDir ?? paths().checkSocketsDir;
    await mkdir(socketsDir, { recursive: true, mode: 0o700 });
    const sockets = await mkdtemp(join(socketsDir, "c"));
    try {
      const tooDeep = socketPathProblem(sockets, options.platform);
      if (tooDeep) {
        return {
          exitCode: null,
          timedOut: false,
          output: "",
          notRun: `the sandbox could not start: ${tooDeep}`,
        };
      }
      const settings = checkSandboxSettings(job, { ...dirs, sockets }, options);
      const env = await checkSandboxEnv(dirs.root, options.env);
      const mac = (options.platform ?? process.platform) === "darwin";
      const r = await sandboxedExec(
        settings,
        command,
        {
          cwd: dirs.dir,
          env,
          sockets,
          reapUnder: dirs.root,
          ...(mac ? { denyExec: MAC_DENY_EXEC } : {}),
          ...(options.node ? { node: options.node } : {}),
        },
        signal,
      );
      // On macOS this is the weaker sandbox a Mac runner's owner opted in to (fourth review).
      return r.notRun ? r : { ...r, isolation: mac ? "weaker-sandbox" : "sandbox" };
    } finally {
      await rm(sockets, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * The local check exec for a job, or null when this runner has no OS sandbox (the host then reports
 * every check "not run"). Each command runs in its check's tree through ./check-sandbox-child.mjs,
 * after a start-up trial (cached while it passes) shows the sandbox really starts here: where it
 * doesn't, every check is "not run: the sandbox could not start", never a failure for a fix round.
 */
export function checkSandbox(
  options: CheckSandboxOptions,
): ((job: Job, dirs: CheckDirs) => Exec) | null {
  const platform = options.platform ?? process.platform;
  if (!(options.available ?? sandboxAvailable(platform, options.env))) return null;
  let trial: { at: number; result: Promise<TrialResult> } | undefined;
  const started = (signal: AbortSignal) => {
    if (!trial || Date.now() - trial.at > TRIAL_FRESH_MS) {
      const result = sandboxTrial(options, signal);
      trial = { at: Date.now(), result };
      // A failed trial is tried again by the next check (the owner may have fixed it).
      void result.then((r) => {
        if (!r.ok && trial?.result === result) trial = undefined;
      });
    }
    return trial.result;
  };
  return (job, dirs) => {
    const exec = runInSandbox(options, job, dirs);
    return async (command, signal) => {
      const t = await started(signal);
      if (!t.ok) {
        const reason = t.reason.startsWith("the sandbox could not start")
          ? t.reason
          : `the sandbox could not start: ${t.reason}`;
        return { exitCode: null, timedOut: false, output: "", notRun: reason.slice(0, 300) };
      }
      return exec(command, signal);
    };
  };
}
