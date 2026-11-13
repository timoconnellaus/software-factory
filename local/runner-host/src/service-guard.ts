// SF Runner.app's `service.cjs` (spec 45 §1): the guard, which launchd starts through the launcher,
// and the self-test a new version runs before it is swapped in (§5).
//
// Spec 45 PR 2 ships the self-test only: it reports what it was started with (the bundle's sealed
// version.json, the bundle it was started from, its working directory, the names of the environment
// variables, Node's own flags and its open descriptors), which the launcher's tests compare with §1. The guard itself (crash loop, confirm deadline, rollback) is PR 4; until
// then nothing installs the service, and started without `--selftest` this exits 64.
import { fstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cliArgsAllowed } from "./launcher-entries.ts";

export interface SelfTest {
  ok: true;
  version: unknown;
  /** SF_RUNNER_BUNDLE: the bundle the launcher validated (its resolved path). */
  bundle: string;
  cwd: string;
  envKeys: string[];
  execArgv: string[];
  argv: string[];
  /** Every open descriptor, with the device and inode behind it (a test matches them to its own). */
  fds: { fd: number; dev: number; ino: number }[];
}

function openFds(): SelfTest["fds"] {
  const fds: SelfTest["fds"] = [];
  for (const name of readdirSync("/dev/fd")) {
    const fd = Number(name);
    try {
      const st = fstatSync(fd);
      fds.push({ fd, dev: st.dev, ino: st.ino });
    } catch {
      // The descriptor readdir itself had open, gone by now.
    }
  }
  return fds.sort((a, b) => a.fd - b.fd);
}

export function selfTest(env: NodeJS.ProcessEnv = process.env): SelfTest {
  const bundle = env.SF_RUNNER_BUNDLE;
  if (!bundle) throw new Error("not started by SF Runner's launcher (no SF_RUNNER_BUNDLE)");
  const version = JSON.parse(
    readFileSync(join(bundle, "Contents", "Resources", "version.json"), "utf8"),
  );
  return {
    ok: true,
    version,
    bundle,
    cwd: process.cwd(),
    envKeys: Object.keys(env).sort(),
    execArgv: process.execArgv,
    argv: process.argv.slice(1),
    fds: openFds(),
  };
}

function main(): void {
  if (!cliArgsAllowed("service.cjs", process.argv.slice(2))) {
    process.stderr.write("sf-runner service: not one of SF Runner's entries\n");
    process.exitCode = 64;
    return;
  }
  if (process.argv.includes("--selftest")) {
    process.stdout.write(`${JSON.stringify(selfTest())}\n`);
    return;
  }
  process.stderr.write("sf-runner service: the guard isn't built yet (spec 45, PR 4)\n");
  process.exitCode = 64;
}

if (process.env.SF_RUNNER_SERVICE === "1") main();
