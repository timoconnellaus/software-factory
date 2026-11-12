#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import {
  checkRunningHarness,
  diagnose,
  jobIdOf,
  migrateRunnerRepos,
  nodeExec,
  orcaCli,
  reapOrphanWorktrees,
} from "@software-factory/runner-orca";
import type { RunnerConfig } from "./config.ts";
import {
  configSchema,
  DEFAULT_APP_URL,
  DEFAULT_BASE_URL,
  loadConfig,
  paths,
  redacted,
  saveConfig,
} from "./config.ts";
import { deviceLogin } from "./device-login.ts";
// `sf-runner`: connect this machine to the factory, run the runner, install it as a launchd service.
//
//   sf-runner login [--name m5] [--url https://sf-engine.zerobsai.com] [--app https://…] [--no-install]
//                                  print a code, wait for approval in the app, save the key, install
//   sf-runner pair --runner-id r_… --key-stdin   (fallback: a key registered in Setup)
//   sf-runner run                  run in the foreground (what the service runs)
//   sf-runner status               config (key redacted), service state, the jobs it is running,
//                                  and its version against the desired one (self-update, ADR 0360)
//   sf-runner doctor [--fix]       check node, git, orca, claude, the channel, Orca's repos
//                                  (duplicate source repos for one remote, job worktrees with no
//                                  job), and that each running job's Claude runs exactly as the
//                                  harness launched it (ADR 0270)
//   sf-runner install | uninstall  the launchd service (~/Library/LaunchAgents)
import { acquireHostLock, HostLockedError } from "./host-lock.ts";
import * as launchd from "./launchd.ts";
import { readLiveJobs } from "./live-jobs.ts";
import { parsePairingInput, serviceNode, withOrcaOnPath } from "./pairing.ts";
import { buildRunner, liveJobsFile } from "./runner.ts";
import {
  createSelfUpdater,
  pnpmInstall,
  readUpdateRecord,
  readVersionStatus,
  runnerRepo,
  type SelfUpdate,
  UPDATE_EXIT_CODE,
} from "./self-update.ts";

const dirs = paths();
/** `local/runner-host/src` of the checkout this CLI runs from. */
const srcDir = () => dirname(realpathSync(new URL(import.meta.url).pathname));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function requireConfig() {
  const config = await loadConfig(dirs.configFile);
  if (!config) {
    console.error(
      `Not connected: no ${dirs.configFile}. Run\n  local/runner-host/bin/sf-runner login`,
    );
    // A clean exit, so launchd doesn't restart an unpaired runner in a loop.
    process.exit(0);
  }
  return config;
}

async function pair(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "runner-id": { type: "string" },
      key: { type: "string" },
      "key-stdin": { type: "boolean" },
      url: { type: "string" },
      name: { type: "string" },
      max: { type: "string" },
      "max-light": { type: "string" },
    },
  });
  const existing = await loadConfig(dirs.configFile).catch(() => null);
  // stdin takes the bare key or the app's `runner id: …` / `key: …` block.
  const piped = values["key-stdin"]
    ? parsePairingInput(await readStdin(), values["runner-id"])
    : null;
  const key = piped?.key ?? values.key ?? existing?.key;
  const config = configSchema.parse({
    ...(existing ?? {}),
    baseUrl: values.url ?? existing?.baseUrl ?? DEFAULT_BASE_URL,
    runnerId: piped?.runnerId ?? values["runner-id"] ?? existing?.runnerId,
    key,
    ...(values.name ? { name: values.name } : {}),
    ...(values.max ? { maxConcurrent: Number(values.max) } : {}),
    ...(values["max-light"] ? { maxLight: Number(values["max-light"]) } : {}),
  });
  await adopt(config);
}

/** Proves the key with one signed heartbeat, then saves the config (0600) and restarts the service. */
async function adopt(config: RunnerConfig) {
  const { cp, adapter } = buildRunner(config, dirs);
  // Prove the pairing: one signed heartbeat with the real manifest, holding nothing.
  const manifest = await adapter.manifest();
  try {
    await cp.heartbeat({
      manifest,
      capacity: {
        max: config.maxConcurrent,
        inUse: 0,
        accepting: false,
        light: { max: config.maxLight, inUse: 0 },
      },
      activeJobs: [],
      rateLimitedUntil: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/401|signature/i.test(message)) {
      throw new Error(
        `${message}\nThe factory didn't accept this key for ${config.runnerId}. Check the runner id matches the key (Setup shows both), or rotate the key in the app and pair again.`,
      );
    }
    throw err;
  }
  await saveConfig(dirs.configFile, config);
  console.log(`Paired ${config.runnerId} with ${config.baseUrl}; config in ${dirs.configFile}`);
  if (await launchd.kickstart(nodeExec)) console.log("Restarted the launchd service.");
}

/**
 * Device login (ADR 0056): a code to approve in the app instead of a key to copy. Checks Node
 * before asking for a code when it will install the service, so an approval isn't wasted.
 */
async function login(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      url: { type: "string" },
      app: { type: "string" },
      max: { type: "string" },
      "max-light": { type: "string" },
      "no-install": { type: "boolean" },
      "no-open": { type: "boolean" },
    },
  });
  const installing = !values["no-install"];
  if (installing)
    serviceNode({ execPath: process.execPath, version: process.version, path: process.env.PATH });
  const existing = await loadConfig(dirs.configFile).catch(() => null);
  const baseUrl = values.url ?? existing?.baseUrl ?? DEFAULT_BASE_URL;
  const suggested = values.name ?? existing?.name ?? hostname().replace(/\.local$/, "");
  const got = await deviceLogin({
    baseUrl,
    appUrl: values.app ?? DEFAULT_APP_URL,
    name: suggested.slice(0, 80),
    ...(values["no-open"] || process.platform !== "darwin"
      ? {}
      : {
          open: (url: string) => {
            spawn("open", [url], { stdio: "ignore", detached: true }).on("error", () => {});
          },
        }),
  });
  const config = configSchema.parse({
    ...(existing ?? {}),
    baseUrl,
    runnerId: got.runnerId,
    key: got.key,
    ...(got.name ? { name: got.name } : {}),
    ...(values.max ? { maxConcurrent: Number(values.max) } : {}),
    ...(values["max-light"] ? { maxLight: Number(values["max-light"]) } : {}),
  });
  console.log(`Approved: ${got.name ?? got.runnerId}.`);
  await adopt(config);
  if (installing) await install([]);
}

async function run() {
  const config = await requireConfig();
  await mkdir(dirs.runsDir, { recursive: true, mode: 0o700 });
  // One host per machine (ADR 0380): a second `run` (an orphan, launchd and the desktop app both)
  // would fight the first over leases.
  let releaseLock: () => void;
  try {
    releaseLock = acquireHostLock(dirs.stateDir);
  } catch (error) {
    if (error instanceof HostLockedError) {
      console.error(error.message);
      process.exit(3);
    }
    throw error;
  }
  process.on("exit", () => releaseLock());
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const selfUpdate = await startSelfUpdate(config, log);
  const { host } = buildRunner(config, dirs, {
    log,
    ...(selfUpdate ? { selfUpdate } : {}),
    // Updated and idle: exit non-zero so launchd (KeepAlive, SuccessfulExit=false) starts the new code.
    onUpdated: () => {
      log(`exiting ${UPDATE_EXIT_CODE} so launchd starts the updated runner`);
      process.exit(UPDATE_EXIT_CODE);
    },
  });
  log(
    `runner ${config.runnerId} (contract v${CONTRACT_VERSION}) → ${config.baseUrl}, up to ${config.maxConcurrent} heavy and ${config.maxLight} light jobs`,
  );
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping; running jobs are cancelled and released`);
    await host.stop({ cancel: true, timeoutMs: 90_000 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await host.start();
  // The host's timers keep the process alive.
}

/** The self-updater for this checkout, or undefined when it isn't a git checkout. */
async function startSelfUpdate(
  config: RunnerConfig,
  log: (m: string) => void,
): Promise<SelfUpdate | undefined> {
  try {
    const repo = await runnerRepo(nodeExec, srcDir());
    if (!repo) {
      log("self-update off: the runner isn't running from a git checkout");
      return undefined;
    }
    const updater = await createSelfUpdater({
      repo,
      stateDir: dirs.stateDir,
      autoUpdate: config.autoUpdate,
      canRestart: process.env.SF_RUNNER_SERVICE === "1",
      exec: nodeExec,
      installDeps: pnpmInstall(nodeExec),
      log,
    });
    const { sha, update } = updater.report();
    log(
      `code ${sha.slice(0, 7)} in ${repo}; auto-update ${config.autoUpdate ? "on" : "off"}${update.state === "rolled_back" ? `; last update rolled back: ${update.reason}` : ""}`,
    );
    return updater;
  } catch (err) {
    log(`self-update off: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

async function status() {
  const config = await loadConfig(dirs.configFile).catch(() => null);
  console.log(
    config ? JSON.stringify(redacted(config), null, 2) : `not paired (${dirs.configFile})`,
  );
  const service = await launchd.status(nodeExec);
  console.log(`service: ${service ?? "not installed"}`);
  const live = await readLiveJobs(liveJobsFile(dirs));
  console.log(
    live
      ? `jobs running: ${live.jobs.length ? live.jobs.join(", ") : "none"} (host pid ${live.pid}, ${live.updatedAt})`
      : service && /state = running/.test(service)
        ? "jobs running: unknown (the service predates the live-jobs file; check Orca for sf-job: worktrees)"
        : "jobs running: none (no host running)",
  );
  // What Orca holds, whichever host made it: wait for this to be empty before upgrading.
  const rows = await orcaCli({ ...(config?.orcaBin ? { bin: config.orcaBin } : {}) })
    .worktreePs()
    .catch(() => null);
  const jobRows = rows?.filter((r) => jobIdOf(r.comment)) ?? [];
  console.log(
    rows === null
      ? "job worktrees in Orca: unknown (orca not reachable)"
      : `job worktrees in Orca: ${jobRows.length ? jobRows.map((r) => `${jobIdOf(r.comment)} (${r.agents.map((a) => a.state).join(",") || "no agent"})`).join(", ") : "none"}`,
  );
  const version = await readVersionStatus(dirs.stateDir);
  const record = await readUpdateRecord(dirs.stateDir);
  const sha7 = (s: string | null | undefined) => (s ? s.slice(0, 12) : "unknown");
  if (version) {
    console.log(
      [
        `version: ${sha7(version.sha)} (auto-update ${version.autoUpdate ? "on" : "off"})`,
        `desired: ${version.desired ? sha7(version.desired) : "unknown (the engine didn't say)"}`,
        `update: ${version.state}${version.target && version.target !== version.desired ? ` → ${sha7(version.target)}` : ""}${version.reason ? ` (${version.reason})` : ""}`,
        `  as of ${version.at}`,
      ].join("\n"),
    );
  } else {
    console.log("version: unknown (no heartbeat recorded by a self-updating runner yet)");
  }
  if (record?.status === "pending") {
    console.log(
      `update in progress: ${sha7(record.from)} → ${sha7(record.to)}, ${record.starts} start(s) without a confirmation (rolled back after 3)`,
    );
  }
  console.log(`state: ${dirs.stateDir}\nlog: ${join(dirs.logDir, "runner.log")}`);
}

/**
 * The jobs a running host holds, for doctor. `null` when that can't be known: the service is up but
 * wrote no live-jobs file (a host from before it existed), so nothing may be treated as an orphan.
 */
async function liveJobs(): Promise<Set<string> | null> {
  const live = await readLiveJobs(liveJobsFile(dirs));
  if (live) return new Set(live.jobs);
  const service = await launchd.status(nodeExec);
  return service && /state = running/.test(service) ? null : new Set();
}

async function doctor(args: string[]) {
  const { values } = parseArgs({ args, options: { fix: { type: "boolean" } } });
  let ok = true;
  const check = async (what: string, fn: () => Promise<string>) => {
    try {
      console.log(`✓ ${what}: ${await fn()}`);
    } catch (err) {
      ok = false;
      console.log(`✗ ${what}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const version = async (cmd: string, args = ["--version"]) => {
    const r = await nodeExec(cmd, args, { timeoutMs: 20_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${cmd} exited ${r.code}`);
    return r.stdout.trim().split("\n")[0] ?? "";
  };
  await check("node ≥ 24", async () => {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error(process.version);
    return process.version;
  });
  await check("git", () => version("git"));
  await check("orca", () => version("orca"));
  await check("claude", () => version("claude"));
  await check("orca reachable", async () => {
    const r = await nodeExec("orca", ["repo", "list", "--json"], { timeoutMs: 20_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
    return "yes";
  });
  const orcaBin = (await loadConfig(dirs.configFile).catch(() => null))?.orcaBin;
  const orcaOptions = { ...(orcaBin ? { bin: orcaBin } : {}), exec: nodeExec };
  await check("orca repos (one source repo per remote, no orphaned job worktrees)", async () => {
    const live = await liveJobs();
    const findings = await diagnose({
      ...orcaOptions,
      ownReposDir: dirs.reposDir,
      live: live ?? new Set(),
    });
    // Without a live-jobs list every job worktree would look orphaned: don't report or fix those.
    const relevant = live ? findings : findings.filter((f) => f.kind !== "orphan-worktree");
    if (relevant.length === 0) {
      return live
        ? "ok"
        : "ok (job worktrees not checked: the running service doesn't report its jobs)";
    }
    for (const f of relevant)
      console.log(`  - ${f.message}${f.fixable ? "" : " (not fixable here)"}`);
    if (!values.fix) throw new Error(`${relevant.length} problem(s); run sf-runner doctor --fix`);
    if (live) {
      const reaped = await reapOrphanWorktrees(orcaOptions, live);
      if (reaped.length) console.log(`  fixed: removed worktrees of ${reaped.join(", ")}`);
    }
    for (const m of await migrateRunnerRepos({
      ...orcaOptions,
      ownReposDir: dirs.reposDir,
      live,
    })) {
      console.log(
        m.skipped
          ? `  not fixed: ${m.key}: ${m.skipped}`
          : `  fixed: ${m.key} now uses ${m.kept.path}; unregistered and deleted ${m.retired.path}`,
      );
    }
    const after = await diagnose({
      ...orcaOptions,
      ownReposDir: dirs.reposDir,
      live: live ?? new Set(),
    });
    const left = live ? after : after.filter((f) => f.kind !== "orphan-worktree");
    if (left.length) throw new Error(`${left.length} problem(s) left after --fix`);
    return "fixed";
  });
  await check("running jobs' harness (permission mode, setting sources, settings)", async () => {
    const live = await liveJobs();
    // Unknown live set (an old host): check every run dir that has a launch record.
    const jobs = live ? [...live] : await readdir(dirs.runsDir).catch(() => [] as string[]);
    const lines: string[] = [];
    let bad = 0;
    for (const jobId of jobs) {
      const checked = await checkRunningHarness(join(dirs.runsDir, jobId));
      if (!checked) {
        if (live) lines.push(`${jobId}: no launch record (started by an older runner?)`);
        continue;
      }
      if (checked.problems.length) {
        bad++;
        lines.push(`${jobId}: harness-config-mismatch: ${checked.problems.join("; ")}`);
      } else {
        lines.push(`${jobId}: ${checked.record.mode}, as launched`);
      }
    }
    for (const line of lines) console.log(`  - ${line}`);
    if (bad) throw new Error(`${bad} job(s) not running as the harness launched them`);
    return lines.length ? "ok" : "no jobs running";
  });
  const raw = await readFile(dirs.configFile, "utf8").catch(() => "");
  if (/"permissionMode"/.test(raw)) {
    console.log(
      `! ${dirs.configFile} sets permissionMode, which is ignored: the project's policy sets it (ADR 0270)`,
    );
  }
  const config = await loadConfig(dirs.configFile).catch(() => null);
  if (!config) {
    console.log(`✗ paired: no ${dirs.configFile}`);
    ok = false;
  } else {
    await check("channel", async () => {
      const { cp, adapter } = buildRunner(config, dirs);
      await cp.heartbeat({
        manifest: await adapter.manifest(),
        capacity: {
          max: config.maxConcurrent,
          inUse: 0,
          accepting: false,
          light: { max: config.maxLight, inUse: 0 },
        },
        activeJobs: [],
        rateLimitedUntil: null,
      });
      return `${config.runnerId} @ ${config.baseUrl}`;
    });
  }
  process.exit(ok ? 0 : 1);
}

async function install(args: string[]) {
  const { values } = parseArgs({ args, options: { from: { type: "string" } } });
  const runnerHost = values.from
    ? resolve(values.from, "local/runner-host")
    : resolve(srcDir(), "..");
  const wrapper = join(runnerHost, "bin", "sf-runner-service");
  if (!existsSync(wrapper)) throw new Error(`No ${wrapper}: is that a software-factory checkout?`);
  const file = launchd.plistPath();
  // Refuses Node < 24 and pins the service to this absolute Node (incident 2026-11-11-bootstrap).
  const pinned = serviceNode({
    execPath: process.execPath,
    version: process.version,
    path: process.env.PATH,
  });
  // Orca's bin directory, even from a shell without it (an SSH session, incident #9).
  const config = await loadConfig(dirs.configFile).catch(() => null);
  const { path, added } = withOrcaOnPath({
    path: pinned.path,
    orcaBin: config?.orcaBin,
    isFile: (f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    },
  });
  if (added) console.log(`Added ${added} to the service's PATH (orca wasn't on this shell's).`);
  else if (!path.split(":").some((d) => existsSync(join(d, "orca")))) {
    console.log("! orca isn't on the service's PATH and Orca.app wasn't found: jobs won't start.");
  }
  await mkdir(dirs.logDir, { recursive: true });
  await launchd.install(
    nodeExec,
    file,
    launchd.plist({
      node: pinned.node,
      wrapper,
      workingDirectory: runnerHost,
      path,
      home: process.env.HOME ?? "",
      logFile: join(dirs.logDir, "runner.log"),
      stateDir: dirs.stateDir,
      ...(process.env.SF_RUNNER_CONFIG ? { configFile: process.env.SF_RUNNER_CONFIG } : {}),
    }),
  );
  console.log(
    `Installed ${launchd.LABEL} (${file}) running ${wrapper} on Node ${process.version} (${pinned.node})`,
  );
  console.log(`Logs: ${join(dirs.logDir, "runner.log")}`);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = {
  login,
  pair,
  run,
  status,
  doctor,
  install,
  uninstall: async () => {
    await launchd.uninstall(nodeExec, launchd.plistPath());
    console.log(`Removed ${launchd.LABEL}`);
  },
};
const fn = command ? commands[command] : undefined;
if (!fn) {
  console.log("usage: sf-runner login|run|status|doctor [--fix]|install|uninstall");
  process.exit(command ? 2 : 0);
}
fn(rest).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
