// Signing and notarizing the desktop app on macOS (spec 40 M4, ADR 0390). Used by the build hooks:
// nothing here runs unless MACOS_SIGNING_IDENTITY is set (CI's `release` environment, or a Mac
// with the Developer ID in its keychain), so local builds stay unsigned.
//
// Env: MACOS_SIGNING_IDENTITY ("Developer ID Application: …"), MACOS_KEYCHAIN (optional, the
// keychain CI imported the certificate into), and for notarization NOTARY_KEY_PATH (the App Store
// Connect .p8), NOTARY_KEY_ID and NOTARY_ISSUER_ID. Without the notary variables it signs only.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ENTITLEMENTS = resolve(import.meta.dir, "../native/entitlements.plist");
/** The runtimes that JIT: Bun runs the main process, Node runs the runner. */
const JIT = new Set(["bun", "node"]);

export const signingIdentity = () => process.env.MACOS_SIGNING_IDENTITY?.trim() || null;

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.filter((a) => !a.includes(".p8")).join(" ")} failed:\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r.stdout;
}

function isMachO(file: string): boolean {
  const fd = readFileSync(file).subarray(0, 4);
  const magic = fd.readUInt32BE(0);
  // 64-bit and fat, either byte order.
  return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

/** Every Mach-O file under `dir`, deepest first (inside-out signing). */
function machOs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size > 4 && isMachO(p)) out.push(p);
    }
  };
  walk(dir);
  return out.sort((a, b) => b.split("/").length - a.split("/").length);
}

function codesign(path: string, identity: string, entitlements?: string) {
  const args = ["--force", "--sign", identity, "--options", "runtime", "--timestamp"];
  if (entitlements) args.push("--entitlements", entitlements);
  if (process.env.MACOS_KEYCHAIN) args.push("--keychain", process.env.MACOS_KEYCHAIN);
  run("codesign", [...args, path]);
}

/** Signs every binary in the bundle, then the bundle, with the hardened runtime. */
export function signApp(app: string, identity: string) {
  for (const file of machOs(join(app, "Contents"))) {
    const base = file.split("/").pop() ?? "";
    codesign(file, identity, JIT.has(base) ? ENTITLEMENTS : undefined);
  }
  codesign(app, identity);
  run("codesign", ["--verify", "--strict", "--deep", "--verbose=2", app]);
}

/** Submits the bundle to Apple's notary service, waits, and staples the ticket to it. */
export function notarizeApp(app: string): boolean {
  const key = process.env.NOTARY_KEY_PATH;
  const keyId = process.env.NOTARY_KEY_ID;
  const issuer = process.env.NOTARY_ISSUER_ID;
  if (!key || !keyId || !issuer) {
    console.log("notarize: skipped (no NOTARY_KEY_PATH / NOTARY_KEY_ID / NOTARY_ISSUER_ID)");
    return false;
  }
  const zip = `${app}.notarize.zip`;
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  try {
    const out = run("xcrun", [
      "notarytool",
      "submit",
      zip,
      "--key",
      key,
      "--key-id",
      keyId,
      "--issuer",
      issuer,
      "--wait",
      "--timeout",
      "30m",
      "--output-format",
      "json",
    ]);
    const result = JSON.parse(out) as { status?: string; id?: string };
    if (result.status !== "Accepted") {
      const log = result.id
        ? spawnSync(
            "xcrun",
            ["notarytool", "log", result.id, "--key", key, "--key-id", keyId, "--issuer", issuer],
            {
              encoding: "utf8",
            },
          ).stdout
        : "";
      throw new Error(`notarization ${result.status ?? "failed"}:\n${log}`);
    }
  } finally {
    rmSync(zip, { force: true });
  }
  run("xcrun", ["stapler", "staple", app]);
  return true;
}

/** The one .app in the build directory (the inner app at postBuild, the wrapper at postWrap). */
export function builtApp(): string {
  const dir = process.env.ELECTROBUN_BUILD_DIR;
  if (!dir)
    throw new Error("ELECTROBUN_BUILD_DIR is not set: run this from an Electrobun build hook");
  const apps = readdirSync(dir).filter((n) => n.endsWith(".app"));
  if (apps.length !== 1)
    throw new Error(`expected one .app in ${dir}, found ${apps.join(", ") || "none"}`);
  return join(dir, apps[0] as string);
}
