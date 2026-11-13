// The key helper's place in the release (spec 40 M4b, ADR 0394), run by the postPackage hook.
//
// Electrobun signs every Mach-O and nested bundle it finds, with the app's own entitlements, and
// does it inside `electrobun build` before it notarizes and tars the app: a helper placed in
// `postBuild` comes out re-signed with JIT and `disable-library-validation` and without its
// keychain access group (tried 2026-11-13). `postWrap` runs after the app is already in the update
// archive. So the helper goes in here, after Electrobun is done:
//
//   1. unpack the update archive Electrobun made (its app is signed, notarized and stapled);
//   2. put `SF Keys.app` (built by scripts/bundle.sh, profile embedded) in `Contents/Helpers`;
//   3. sign the helper with its own entitlements, then re-sign the app's outer seal (the main
//      executable and the seal over everything, with the entitlements Electrobun used; nothing
//      else in the bundle is touched);
//   4. run the helper once (the launch smoke test: macOS kills a helper whose profile doesn't
//      authorise its entitlements);
//   5. notarize and staple again, since the new seal isn't the one Apple saw;
//   6. tar and compress it as Electrobun does, and rewrite the manifest's `tarSha256` / `tarSize`.
//
// Delta patches are off when the helper ships (electrobun.config.ts): Electrobun diffs against its
// own archive, which this replaces. Without the helper's profile none of this runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export const HELPER_ID = "com.software-factory.desktop.keys";
export const HELPER_NAME = "SF Keys.app";
/** Where scripts/bundle.sh leaves the unsigned helper (only when the release has its profile). */
export const HELPER_SOURCE = `vendor/${HELPER_NAME}`;
export const HELPER_EXECUTABLE = `Contents/Helpers/${HELPER_NAME}/Contents/MacOS/sf-keys`;

export type HelperPlan =
  | { skip: string }
  | {
      archive: string;
      manifests: string[];
      teamId: string;
      identity: string;
      notarize: { key: string; keyId: string; issuer: string } | null;
    };

/** What the hook does about the helper for this build. Throws on a half-configured release. */
export function helperPlan(env: Env, files: string[], hasHelper: boolean): HelperPlan {
  const channel = env.ELECTROBUN_BUILD_ENV ?? "dev";
  if (!hasHelper) return { skip: "no key helper (the release has no MACOS_KEYS_PROFILE)" };
  if (channel === "dev") return { skip: "dev build" };
  const identity = env.ELECTROBUN_DEVELOPER_ID;
  if (!identity) return { skip: "unsigned build" };
  if (env.ELECTROBUN_OS !== "macos") return { skip: "not macOS" };
  const teamId = env.ELECTROBUN_TEAMID ?? "";
  if (!/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error("key helper: ELECTROBUN_TEAMID is not a Team ID");
  const head = `${channel}-macos-arm64-`;
  const archive = files.find((n) => n.startsWith(head) && n.endsWith(".app.tar.zst"));
  if (!archive) throw new Error(`key helper: no ${channel} .app.tar.zst in the artifacts`);
  const patches = files.filter((n) => n.endsWith(".patch"));
  if (patches.length)
    throw new Error(`key helper: delta patches would rebuild Electrobun's archive: ${patches}`);
  const manifests = files.filter((n) => n.startsWith(head) && /-update(-v2)?\.json$/.test(n));
  const { ELECTROBUN_APPLEAPIKEYPATH: key, ELECTROBUN_APPLEAPIKEY: keyId } = env;
  const issuer = env.ELECTROBUN_APPLEAPIISSUER;
  return {
    archive,
    manifests,
    teamId,
    identity,
    notarize: key && keyId && issuer ? { key, keyId, issuer } : null,
  };
}

/** The helper's entitlements file with the Team ID filled in. */
export function helperEntitlements(template: string, teamId: string): string {
  if (!template.includes("TEAM_ID")) throw new Error("key helper: entitlements have no TEAM_ID");
  return template.replaceAll("TEAM_ID", teamId);
}

/** A manifest with the rebuilt archive's hash and size (`-update.json` has neither, and keeps it). */
export function rewriteManifest(body: string, tarSha256: string, tarSize: number): string {
  const doc = JSON.parse(body) as { artifact?: Record<string, unknown> };
  if (!doc.artifact) throw new Error("key helper: manifest has no artifact");
  if (!("tarSha256" in doc.artifact)) return body;
  doc.artifact.tarSha256 = tarSha256;
  doc.artifact.tarSize = tarSize;
  return JSON.stringify(doc);
}

/**
 * The launch smoke test's verdict on one run of the spike's helper: it must exit 0 (not be killed
 * by AMFI) and report the access group in its own entitlements.
 */
export function smokeVerdict(
  r: { status: number | null; signal: string | null; stdout: string },
  teamId: string,
): string | null {
  if (r.signal)
    return `the helper was killed (${r.signal}): macOS refused its signature or profile`;
  if (r.status !== 0) return `the helper exited ${r.status}`;
  let ents: Record<string, unknown>;
  try {
    ents = JSON.parse(r.stdout);
  } catch {
    return `the helper printed no entitlements: ${r.stdout.slice(0, 200)}`;
  }
  const group = `${teamId}.${HELPER_ID}`;
  const groups = ents["keychain-access-groups"];
  if (!Array.isArray(groups) || groups.length !== 1 || groups[0] !== group)
    return `the helper's access groups are ${JSON.stringify(groups)}, not [${group}]`;
  if (ents["com.apple.application-identifier"] !== group)
    return `the helper's application identifier is ${ents["com.apple.application-identifier"]}`;
  return null;
}

function run(cmd: string, args: string[], opts: { env?: Env } = {}): string {
  const r = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`key helper: ${cmd} ${args[0]} failed (${r.status})`);
  return r.stdout.toString();
}

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Steps 1 to 6 above, on the artifacts folder. */
export async function installHelper(
  plan: Exclude<HelperPlan, { skip: string }>,
  artifacts: string,
  buildDir: string,
): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "sf-keys-helper-"));
  try {
    const archive = join(artifacts, plan.archive);
    run("tar", ["-xf", archive, "-C", work]);
    const app = readdirSync(work).find((n) => n.endsWith(".app"));
    if (!app) throw new Error(`key helper: no .app in ${plan.archive}`);
    const appPath = join(work, app);
    const helper = join(appPath, "Contents", "Helpers", HELPER_NAME);
    rmSync(helper, { recursive: true, force: true });
    cpSync(HELPER_SOURCE, helper, { recursive: true, verbatimSymlinks: true });

    const ents = join(work, "sf-keys.entitlements");
    const template = readFileSync("native/sf-keys-app/sf-keys.entitlements", "utf8");
    writeFileSync(ents, helperEntitlements(template, plan.teamId));
    const sign = ["--force", "--sign", plan.identity, "--options", "runtime", "--timestamp"];
    run("codesign", [...sign, "--entitlements", ents, helper]);
    // The outer seal, with the entitlements Electrobun signed the app with (no --deep: the other
    // nested code keeps Electrobun's signatures).
    const appEnts = join(buildDir, "entitlements.plist");
    if (!existsSync(appEnts)) throw new Error(`key helper: no ${appEnts}`);
    run("codesign", [...sign, "--entitlements", appEnts, appPath]);
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

    const smoke = spawnSync(join(appPath, HELPER_EXECUTABLE), [], { timeout: 30_000 });
    const verdict = smokeVerdict(
      { status: smoke.status, signal: smoke.signal, stdout: smoke.stdout?.toString() ?? "" },
      plan.teamId,
    );
    if (verdict) throw new Error(`key helper launch smoke test: ${verdict}`);
    console.log(`key helper: launches with its access group (${smoke.stdout.toString().trim()})`);

    if (plan.notarize) {
      const zip = join(work, "notarize.zip");
      run("ditto", ["-c", "-k", "--keepParent", appPath, zip]);
      const out = run("xcrun", [
        "notarytool",
        "submit",
        zip,
        "--key",
        plan.notarize.key,
        "--key-id",
        plan.notarize.keyId,
        "--issuer",
        plan.notarize.issuer,
        "--wait",
        "--output-format",
        "json",
      ]);
      const status = (JSON.parse(out) as { status?: string; id?: string }).status;
      if (status !== "Accepted") throw new Error(`key helper: notarization ${status}: ${out}`);
      rmSync(zip);
      run("xcrun", ["stapler", "staple", appPath]);
      run("xcrun", ["stapler", "validate", appPath]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
    }

    // The archive, as Electrobun makes it: a plain tar without extended attributes, zstd.
    const tar = join(work, "app.tar");
    run("tar", ["--no-xattrs", "-cf", tar, "-C", work, app], { env: { COPYFILE_DISABLE: "1" } });
    const tarSha256 = await sha256(tar);
    const tarSize = statSync(tar).size;
    rmSync(archive);
    run("zstd", ["-q", "-19", "-T0", tar, "-o", archive]);
    for (const m of plan.manifests) {
      const path = join(artifacts, m);
      writeFileSync(path, rewriteManifest(readFileSync(path, "utf8"), tarSha256, tarSize));
    }
    console.log(`key helper: ${plan.archive} rebuilt (tar ${tarSize} bytes, sha256 ${tarSha256})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
