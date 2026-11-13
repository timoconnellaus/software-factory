// SF Runner.app's `service.cjs` (spec 45 §1): the guard, which launchd starts through the launcher,
// and the self-test a new version runs before it is swapped in (§5).
//
// Spec 45 PR 2 ships the self-test only: it reports what it was started with (the bundle's sealed
// version.json, the names of the environment variables and Node's own flags), which the launcher's
// tests compare with §1. The guard itself (crash loop, confirm deadline, rollback) is PR 4; until
// then nothing installs the service, and started without `--selftest` this exits 64.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cliArgsAllowed } from "./launcher-entries.ts";

export interface SelfTest {
  ok: true;
  version: unknown;
  envKeys: string[];
  execArgv: string[];
  argv: string[];
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
    envKeys: Object.keys(env).sort(),
    execArgv: process.execArgv,
    argv: process.argv.slice(1),
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
