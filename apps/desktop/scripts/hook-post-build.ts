// Electrobun postBuild hook (spec 40 M4): the full app is in place and not yet compressed into the
// update archive, so this is where it is signed and notarized. Skipped on dev builds and when no
// signing identity is set.
import { builtApp, notarizeApp, signApp, signingIdentity } from "./macos-sign.ts";

const identity = signingIdentity();
if (
  process.env.ELECTROBUN_BUILD_ENV === "dev" ||
  !identity ||
  process.env.ELECTROBUN_OS !== "macos"
) {
  console.log("postBuild: not signing (dev build, or no MACOS_SIGNING_IDENTITY)");
} else {
  const app = builtApp();
  console.log(`postBuild: signing ${app}`);
  signApp(app, identity);
  if (notarizeApp(app)) console.log("postBuild: notarized and stapled");
}
