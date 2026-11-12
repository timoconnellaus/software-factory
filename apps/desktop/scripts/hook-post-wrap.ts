// Electrobun postWrap hook (spec 40 M4): the self-extracting wrapper (what people download first)
// exists. Sign, notarize and staple it, then zip it into the artifacts as the first-install file.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { builtApp, notarizeApp, signApp, signingIdentity } from "./macos-sign.ts";

const identity = signingIdentity();
const env = process.env.ELECTROBUN_BUILD_ENV ?? "dev";
if (env === "dev" || !identity || process.env.ELECTROBUN_OS !== "macos") {
  console.log("postWrap: not signing (dev build, or no MACOS_SIGNING_IDENTITY)");
} else {
  const app = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ?? builtApp();
  console.log(`postWrap: signing ${app}`);
  signApp(app, identity);
  notarizeApp(app);
  const artifacts = process.env.ELECTROBUN_ARTIFACT_DIR ?? "artifacts";
  const zip = join(artifacts, `${env}-macos-arm64-Software-Factory.zip`);
  const r = spawnSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("couldn't zip the app");
  console.log(`postWrap: ${zip}`);
}
