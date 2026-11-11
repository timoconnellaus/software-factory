#!/usr/bin/env node
// `sf-runner`: pair this machine with the factory, run the runner, install it as a launchd service.
//
//   sf-runner pair --runner-id r_… [--key-stdin] [--url https://sf-engine.zerobsai.com] [--max 2]
//   sf-runner run                  run in the foreground (what the service runs)
//   sf-runner status               config (key redacted) and service state
//   sf-runner doctor               check node, git, orca, claude and the channel
//   sf-runner install | uninstall  the launchd service (~/Library/LaunchAgents)
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { nodeExec } from "@software-factory/runner-orca";
import {
  configSchema,
  DEFAULT_BASE_URL,
  loadConfig,
  paths,
  redacted,
  saveConfig,
} from "./config.ts";
import * as launchd from "./launchd.ts";
import { parsePairingInput, serviceNode } from "./pairing.ts";
import { buildRunner } from "./runner.ts";

const dirs = paths();

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function requireConfig() {
  const config = await loadConfig(dirs.configFile);
  if (!config) {
    console.error(
      `Not paired: no ${dirs.configFile}. Register a runner in the app (runner.register), then run\n  sf-runner pair --runner-id <id> --key-stdin`,
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
  });
  const { cp, adapter } = buildRunner(config, dirs);
  // Prove the pairing: one signed heartbeat with the real manifest, holding nothing.
  const manifest = await adapter.manifest();
  try {
    await cp.heartbeat({
      manifest,
      capacity: { max: config.maxConcurrent, inUse: 0, accepting: false },
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

async function run() {
  const config = await requireConfig();
  await mkdir(dirs.runsDir, { recursive: true, mode: 0o700 });
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
  const { host } = buildRunner(config, dirs, { log });
  log(
    `runner ${config.runnerId} (contract v${CONTRACT_VERSION}) → ${config.baseUrl}, up to ${config.maxConcurrent} jobs`,
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

async function status() {
  const config = await loadConfig(dirs.configFile).catch(() => null);
  console.log(
    config ? JSON.stringify(redacted(config), null, 2) : `not paired (${dirs.configFile})`,
  );
  console.log(`service: ${(await launchd.status(nodeExec)) ?? "not installed"}`);
  console.log(`state: ${dirs.stateDir}\nlog: ${join(dirs.logDir, "runner.log")}`);
}

async function doctor() {
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
  const config = await loadConfig(dirs.configFile).catch(() => null);
  if (!config) {
    console.log(`✗ paired: no ${dirs.configFile}`);
    ok = false;
  } else {
    await check("channel", async () => {
      const { cp, adapter } = buildRunner(config, dirs);
      await cp.heartbeat({
        manifest: await adapter.manifest(),
        capacity: { max: config.maxConcurrent, inUse: 0, accepting: false },
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
  const here = dirname(realpathSync(new URL(import.meta.url).pathname));
  const cli = values.from
    ? resolve(values.from, "local/runner-host/src/cli.ts")
    : join(here, "cli.ts");
  const file = launchd.plistPath();
  // Refuses Node < 24 and pins the service to this absolute Node (incident 2026-11-11-bootstrap).
  const { node, path } = serviceNode({
    execPath: process.execPath,
    version: process.version,
    path: process.env.PATH,
  });
  await mkdir(dirs.logDir, { recursive: true });
  await launchd.install(
    nodeExec,
    file,
    launchd.plist({
      node,
      cli,
      workingDirectory: resolve(dirname(cli), ".."),
      path,
      home: process.env.HOME ?? "",
      logFile: join(dirs.logDir, "runner.log"),
      ...(process.env.SF_RUNNER_CONFIG ? { configFile: process.env.SF_RUNNER_CONFIG } : {}),
    }),
  );
  console.log(
    `Installed ${launchd.LABEL} (${file}) running ${cli} on Node ${process.version} (${node})`,
  );
  console.log(`Logs: ${join(dirs.logDir, "runner.log")}`);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = {
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
  console.log("usage: sf-runner pair|run|status|doctor|install|uninstall");
  process.exit(command ? 2 : 0);
}
fn(rest).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
