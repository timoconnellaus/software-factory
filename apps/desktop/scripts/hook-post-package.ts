// Electrobun postPackage hook (spec 40 M4): the artifacts folder is final, so the first-install
// download goes in now. Only signed release builds get one.
//
// The download is the plain app, not Electrobun's self-extracting wrapper. The wrapper shows a
// "Software Factory Setup" window that waits for a click, fails when macOS runs it translocated
// (straight from Downloads), and replaces its own bundle on first launch. The plain app is the one
// inside the update archive: Electrobun signed, notarized and stapled it, and updates replace it with
// the same archive, so first install and every update run the same bundle.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/**
 * What the hook does for this build: nothing (dev, unsigned, not macOS), or zip the app from this
 * archive. Throws when a signed release build has no archive to zip.
 */
export function zipPlan(
  env: Env,
  files: string[],
): { skip: string } | { archive: string; zip: string; assess: boolean } {
  const channel = env.ELECTROBUN_BUILD_ENV ?? "dev";
  if (channel === "dev") return { skip: "dev build" };
  if (!env.ELECTROBUN_DEVELOPER_ID) return { skip: "unsigned build" };
  if (env.ELECTROBUN_OS !== "macos") return { skip: "not macOS" };
  const archive = files.find(
    (n) => n.startsWith(`${channel}-macos-arm64-`) && n.endsWith(".app.tar.zst"),
  );
  if (!archive) throw new Error(`postPackage: no ${channel} .app.tar.zst in the artifacts`);
  return {
    archive,
    zip: `${channel}-macos-arm64-Software-Factory.zip`,
    // Gatekeeper's assessment needs the notarization ticket, so only notarized builds get it.
    assess: !!env.ELECTROBUN_APPLEAPIKEYPATH,
  };
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`postPackage: ${cmd} failed (${r.status})`);
}

function main() {
  const artifacts = process.env.ELECTROBUN_ARTIFACT_DIR ?? "artifacts";
  const plan = zipPlan(process.env, readdirSync(artifacts));
  if ("skip" in plan) {
    console.log(`postPackage: no download zip (${plan.skip})`);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "sf-desktop-zip-"));
  try {
    run("tar", ["-xf", join(artifacts, plan.archive), "-C", work]);
    const app = readdirSync(work).find((n) => n.endsWith(".app"));
    if (!app) throw new Error(`postPackage: no .app in ${plan.archive}`);
    // The same checks a downloaded copy gets: the seal, and Gatekeeper's notarization ticket.
    run("codesign", ["--verify", "--deep", "--strict", join(work, app)]);
    if (plan.assess) run("spctl", ["--assess", "--type", "execute", join(work, app)]);
    const zip = join(artifacts, plan.zip);
    run("ditto", ["-c", "-k", "--keepParent", join(work, app), zip]);
    console.log(`postPackage: ${zip}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Electrobun runs the hook as a script; the tests import it.
if (!process.env.VITEST) main();
