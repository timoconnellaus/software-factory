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

const env = process.env.ELECTROBUN_BUILD_ENV ?? "dev";
const artifacts = process.env.ELECTROBUN_ARTIFACT_DIR ?? "artifacts";
if (env === "dev" || !process.env.ELECTROBUN_DEVELOPER_ID || process.env.ELECTROBUN_OS !== "macos") {
  console.log("postPackage: no download zip (dev build, or unsigned)");
} else {
  const archive = readdirSync(artifacts).find(
    (n) => n.startsWith(`${env}-macos-arm64-`) && n.endsWith(".app.tar.zst"),
  );
  if (!archive) throw new Error(`postPackage: no ${env} .app.tar.zst in ${artifacts}`);
  const work = mkdtempSync(join(tmpdir(), "sf-desktop-zip-"));
  try {
    run("tar", ["-xf", join(artifacts, archive), "-C", work]);
    const app = readdirSync(work).find((n) => n.endsWith(".app"));
    if (!app) throw new Error(`postPackage: no .app in ${archive}`);
    // The same checks a downloaded copy gets: the seal, and Gatekeeper's notarization ticket.
    run("codesign", ["--verify", "--deep", "--strict", join(work, app)]);
    if (process.env.ELECTROBUN_APPLEAPIKEYPATH) {
      run("spctl", ["--assess", "--type", "execute", join(work, app)]);
    }
    const zip = join(artifacts, `${env}-macos-arm64-Software-Factory.zip`);
    run("ditto", ["-c", "-k", "--keepParent", join(work, app), zip]);
    console.log(`postPackage: ${zip}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`postPackage: ${cmd} failed (${r.status})`);
}
