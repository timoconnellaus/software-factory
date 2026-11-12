// Electrobun postPackage hook (spec 40 M4): the artifacts folder is final, so the first-install
// download (the signed, notarized wrapper, zipped) goes in now. Only signed release builds get one.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const env = process.env.ELECTROBUN_BUILD_ENV ?? "dev";
const dir = process.env.ELECTROBUN_BUILD_DIR;
if (
  env === "dev" ||
  !process.env.ELECTROBUN_DEVELOPER_ID ||
  process.env.ELECTROBUN_OS !== "macos" ||
  !dir
) {
  console.log("postPackage: no download zip (dev build, or unsigned)");
} else {
  const app =
    process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ??
    join(dir, readdirSync(dir).find((n) => n.endsWith(".app")) ?? "");
  const zip = join(
    process.env.ELECTROBUN_ARTIFACT_DIR ?? "artifacts",
    `${env}-macos-arm64-Software-Factory.zip`,
  );
  const r = spawnSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("couldn't zip the app");
  console.log(`postPackage: ${zip}`);
}
